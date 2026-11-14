package payers

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gagliardetto/solana-go"
	associatedtokenaccount "github.com/gagliardetto/solana-go/programs/associated-token-account"
	"github.com/gagliardetto/solana-go/programs/system"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/UnalignedCorp/unaligned-autopay/go/autopay"
)

var solanaMints = map[string]string{
	"USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
	"USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

const (
	solDecimals         = 9
	mintDecimalsOffset  = 44 // in the SPL mint layout (the same in Token-2022)
	transferCheckedCode = 12 // instruction index in the token programs
	confirmTimeout      = 90 * time.Second
	confirmPoll         = 500 * time.Millisecond
)

// ParseSolanaKey reads a base58 secret key or the JSON byte array that solana-keygen writes.
func ParseSolanaKey(text string) (solana.PrivateKey, error) {
	text = strings.TrimSpace(text)
	var key solana.PrivateKey
	if strings.HasPrefix(text, "[") {
		var numbers []byte
		if err := json.Unmarshal([]byte(text), &numbers); err != nil {
			return nil, fmt.Errorf("SOLANA_PRIVATE_KEY is neither a base58 secret key nor a JSON byte array")
		}
		key = solana.PrivateKey(numbers)
	} else {
		decoded, err := solana.PrivateKeyFromBase58(text)
		if err != nil {
			return nil, fmt.Errorf("SOLANA_PRIVATE_KEY is neither a base58 secret key nor a JSON byte array")
		}
		key = decoded
	}
	if len(key) != 64 {
		return nil, fmt.Errorf("SOLANA_PRIVATE_KEY must hold a 64-byte secret key")
	}
	if _, err := solana.ValidatePrivateKey(key); err != nil {
		return nil, fmt.Errorf("SOLANA_PRIVATE_KEY is not a valid secret key: the public half does not match")
	}
	return key, nil
}

// SolanaPayer pays SOL or an SPL token from one keypair.
type SolanaPayer struct {
	key          solana.PrivateKey
	client       *rpc.Client
	tokenAddress string
}

// NewSolanaPayer reads the key and prepares the RPC client.
func NewSolanaPayer(rpcURL, privateKey, tokenAddress string) (*SolanaPayer, error) {
	key, err := ParseSolanaKey(privateKey)
	if err != nil {
		return nil, err
	}
	return &SolanaPayer{key: key, client: rpc.New(rpcURL), tokenAddress: tokenAddress}, nil
}

// Address is the wallet's public key.
func (p *SolanaPayer) Address(context.Context) (string, error) {
	return p.key.PublicKey().String(), nil
}

// MintFor returns the mint for a coin: "" for SOL, an error for an unknown token.
func (p *SolanaPayer) MintFor(coin string) (string, error) {
	if coin == autopay.NativeCoin["solana"] {
		return "", nil
	}
	mint := p.tokenAddress
	if mint == "" {
		mint = solanaMints[coin]
	}
	if mint == "" {
		return "", fmt.Errorf("no token mint known for %s on solana: set TOKEN_ADDRESS", coin)
	}
	return mint, nil
}

// Send pays SOL, or an SPL token to the recipient's associated token account (created first, idempotently,
// in the same transaction). It waits for the `confirmed` commitment and returns the signature.
func (p *SolanaPayer) Send(ctx context.Context, to, coin, amount string) (string, error) {
	recipient, err := solana.PublicKeyFromBase58(to)
	if err != nil {
		return "", fmt.Errorf("%q is not a Solana address: %w", to, err)
	}
	owner := p.key.PublicKey()

	var instructions []solana.Instruction
	mintAddress, err := p.MintFor(coin)
	if err != nil {
		return "", err
	}
	if mintAddress == "" {
		lamports, err := autopay.ToBaseUnits(amount, solDecimals)
		if err != nil {
			return "", err
		}
		instructions = append(instructions, system.NewTransferInstruction(lamports.Uint64(), owner, recipient).Build())
	} else {
		instructions, err = p.tokenTransfer(ctx, mintAddress, recipient, amount)
		if err != nil {
			return "", err
		}
	}

	latest, err := p.client.GetLatestBlockhash(ctx, rpc.CommitmentConfirmed)
	if err != nil {
		return "", fmt.Errorf("Solana RPC: %w", err)
	}
	tx, err := solana.NewTransaction(instructions, latest.Value.Blockhash, solana.TransactionPayer(owner))
	if err != nil {
		return "", err
	}
	if _, err := tx.Sign(func(k solana.PublicKey) *solana.PrivateKey {
		if k.Equals(owner) {
			return &p.key
		}
		return nil
	}); err != nil {
		return "", err
	}
	signature, err := p.client.SendTransactionWithOpts(ctx, tx, rpc.TransactionOpts{PreflightCommitment: rpc.CommitmentConfirmed})
	if err != nil {
		return "", fmt.Errorf("sending the transaction: %w", err)
	}
	if err := p.waitConfirmed(ctx, signature); err != nil {
		return "", err
	}
	return signature.String(), nil
}

// tokenTransfer builds "create the recipient's token account if missing" and "transfer checked".
func (p *SolanaPayer) tokenTransfer(
	ctx context.Context, mintAddress string, recipient solana.PublicKey, amount string,
) ([]solana.Instruction, error) {
	mint, err := solana.PublicKeyFromBase58(mintAddress)
	if err != nil {
		return nil, fmt.Errorf("%q is not a Solana mint address: %w", mintAddress, err)
	}
	info, err := p.client.GetAccountInfo(ctx, mint)
	if err != nil || info == nil || info.Value == nil {
		return nil, fmt.Errorf("token mint %s not found", mintAddress)
	}
	// The mint's owner is the token program (classic or Token-2022).
	program := info.Value.Owner
	data := info.Value.Data.GetBinary()
	if len(data) <= mintDecimalsOffset {
		return nil, fmt.Errorf("%s is not a token mint", mintAddress)
	}
	decimals := data[mintDecimalsOffset]
	units, err := autopay.ToBaseUnits(amount, int(decimals))
	if err != nil {
		return nil, err
	}

	owner := p.key.PublicKey()
	from, _, err := solana.FindAssociatedTokenAddressWithProgram(owner, mint, program)
	if err != nil {
		return nil, err
	}
	dest, _, err := solana.FindAssociatedTokenAddressWithProgram(recipient, mint, program)
	if err != nil {
		return nil, err
	}
	create := associatedtokenaccount.NewCreateIdempotentInstructionBuilder().
		SetPayer(owner).SetWallet(recipient).SetMint(mint).SetTokenProgram(program).Build()

	// The library's TransferChecked always targets the classic token program, so the instruction is built here
	// to work with Token-2022 mints too: [12, amount (u64 little endian), decimals].
	payload := make([]byte, 10)
	payload[0] = transferCheckedCode
	binary.LittleEndian.PutUint64(payload[1:9], units.Uint64())
	payload[9] = decimals
	transfer := solana.NewInstruction(program, solana.AccountMetaSlice{
		solana.Meta(from).WRITE(),
		solana.Meta(mint),
		solana.Meta(dest).WRITE(),
		solana.Meta(owner).SIGNER(),
	}, payload)
	return []solana.Instruction{create, transfer}, nil
}

// waitConfirmed polls the signature status until `confirmed` (or `finalized`), a failure, or the timeout.
func (p *SolanaPayer) waitConfirmed(ctx context.Context, signature solana.Signature) error {
	ctx, cancel := context.WithTimeout(ctx, confirmTimeout)
	defer cancel()
	ticker := time.NewTicker(confirmPoll)
	defer ticker.Stop()
	for {
		res, err := p.client.GetSignatureStatuses(ctx, true, signature)
		if err == nil && len(res.Value) == 1 && res.Value[0] != nil {
			status := res.Value[0]
			if status.Err != nil {
				return fmt.Errorf("transaction %s failed: %v", signature, status.Err)
			}
			if status.ConfirmationStatus == rpc.ConfirmationStatusConfirmed ||
				status.ConfirmationStatus == rpc.ConfirmationStatusFinalized {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for %s: %w", signature, ctx.Err())
		case <-ticker.C:
		}
	}
}
