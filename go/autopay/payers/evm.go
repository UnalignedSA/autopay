package payers

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/UnalignedCorp/unaligned-autopay/go/autopay"
)

// erc20JSON declares `transfer` with no outputs on purpose: Ethereum USDT returns nothing, and decoding a
// missing bool would fail. Success is the receipt status instead.
const erc20JSON = `[
  {"type":"function","name":"transfer","stateMutability":"nonpayable",
   "inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"decimals","stateMutability":"view",
   "inputs":[],"outputs":[{"name":"","type":"uint8"}]}
]`

// ERC20ABI is the part of ERC-20 this program uses.
var ERC20ABI = mustABI(erc20JSON)

func mustABI(text string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(text))
	if err != nil {
		panic(err)
	}
	return parsed
}

var evmTokens = map[string]map[string]string{
	"ethereum": {
		"USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
		"USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	},
	"bsc": {
		"USDT": "0x55d398326f99059fF775485246999027B3197955",
		"USDC": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
	},
}

const (
	nativeDecimals = 18
	receiptTimeout = 5 * time.Minute
	receiptPoll    = 500 * time.Millisecond
)

// EvmOptions configures an EvmPayer.
type EvmOptions struct {
	RPCURL     string
	PrivateKey string
	Network    string
	// TokenAddress overrides the built-in token contract.
	TokenAddress string
}

// EvmPayer pays from an Ethereum or BSC account.
type EvmPayer struct {
	opts    EvmOptions
	key     *ecdsa.PrivateKey
	address common.Address
}

// NewEvmPayer reads the private key (hex, with or without 0x).
func NewEvmPayer(opts EvmOptions) (*EvmPayer, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(opts.PrivateKey, "0x"))
	if err != nil {
		return nil, fmt.Errorf("EVM_PRIVATE_KEY is not a valid hex private key: %w", err)
	}
	return &EvmPayer{opts: opts, key: key, address: crypto.PubkeyToAddress(key.PublicKey)}, nil
}

// Address is the wallet's own address.
func (p *EvmPayer) Address(context.Context) (string, error) { return p.address.Hex(), nil }

// TokenFor returns the token contract for a coin: "" for the chain's native coin, an error for an unknown token.
func (p *EvmPayer) TokenFor(coin string) (string, error) {
	if autopay.NativeCoin[p.opts.Network] == coin {
		return "", nil
	}
	token := p.opts.TokenAddress
	if token == "" {
		token = evmTokens[p.opts.Network][coin]
	}
	if token == "" {
		return "", fmt.Errorf("no token contract known for %s on %s: set TOKEN_ADDRESS", coin, p.opts.Network)
	}
	return token, nil
}

// Send pays the native coin or a token and waits for one confirmation. It fails if the receipt status is not 1.
func (p *EvmPayer) Send(ctx context.Context, to, coin, amount string) (string, error) {
	if !common.IsHexAddress(to) {
		return "", fmt.Errorf("%q is not an EVM address", to)
	}
	recipient := common.HexToAddress(to)
	token, err := p.TokenFor(coin)
	if err != nil {
		return "", err
	}
	client, err := ethclient.DialContext(ctx, p.opts.RPCURL)
	if err != nil {
		return "", fmt.Errorf("EVM RPC: %w", err)
	}
	defer client.Close()

	target, value, data := recipient, new(big.Int), []byte(nil)
	if token == "" {
		if value, err = autopay.ToBaseUnits(amount, nativeDecimals); err != nil {
			return "", err
		}
	} else {
		contract := common.HexToAddress(token)
		decimals, err := readDecimals(ctx, client, contract)
		if err != nil {
			return "", err
		}
		units, err := autopay.ToBaseUnits(amount, decimals)
		if err != nil {
			return "", err
		}
		if data, err = ERC20ABI.Pack("transfer", recipient, units); err != nil {
			return "", err
		}
		target = contract
	}

	tx, err := p.buildTx(ctx, client, target, value, data)
	if err != nil {
		return "", err
	}
	if err := client.SendTransaction(ctx, tx); err != nil {
		return "", fmt.Errorf("sending the transaction: %w", err)
	}
	receipt, err := waitForReceipt(ctx, client, tx.Hash())
	if err != nil {
		return "", err
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return "", fmt.Errorf("transaction %s reverted", tx.Hash().Hex())
	}
	return tx.Hash().Hex(), nil
}

func readDecimals(ctx context.Context, client *ethclient.Client, contract common.Address) (int, error) {
	input, err := ERC20ABI.Pack("decimals")
	if err != nil {
		return 0, err
	}
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &contract, Data: input}, nil)
	if err != nil {
		return 0, fmt.Errorf("reading decimals of %s: %w", contract.Hex(), err)
	}
	values, err := ERC20ABI.Unpack("decimals", out)
	if err != nil || len(values) != 1 {
		return 0, fmt.Errorf("token %s did not answer decimals()", contract.Hex())
	}
	decimals, ok := values[0].(uint8)
	if !ok {
		return 0, fmt.Errorf("token %s did not answer decimals()", contract.Hex())
	}
	return int(decimals), nil
}

// buildTx prepares and signs a transaction: EIP-1559 when the chain has a base fee, a legacy gas price otherwise.
func (p *EvmPayer) buildTx(
	ctx context.Context, client *ethclient.Client, to common.Address, value *big.Int, data []byte,
) (*types.Transaction, error) {
	chainID, err := client.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("EVM RPC: %w", err)
	}
	nonce, err := client.PendingNonceAt(ctx, p.address)
	if err != nil {
		return nil, fmt.Errorf("reading the nonce: %w", err)
	}
	gas, err := client.EstimateGas(ctx, ethereum.CallMsg{From: p.address, To: &to, Value: value, Data: data})
	if err != nil {
		return nil, fmt.Errorf("estimating gas: %w", err)
	}
	head, err := client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("reading the latest block: %w", err)
	}

	var unsigned types.TxData
	if head.BaseFee != nil {
		tip, err := client.SuggestGasTipCap(ctx)
		if err != nil {
			return nil, fmt.Errorf("reading the gas tip: %w", err)
		}
		// Twice the base fee leaves room for it to rise over a few blocks.
		feeCap := new(big.Int).Add(new(big.Int).Mul(head.BaseFee, big.NewInt(2)), tip)
		unsigned = &types.DynamicFeeTx{
			ChainID: chainID, Nonce: nonce, GasTipCap: tip, GasFeeCap: feeCap, Gas: gas, To: &to, Value: value, Data: data,
		}
	} else {
		price, err := client.SuggestGasPrice(ctx)
		if err != nil {
			return nil, fmt.Errorf("reading the gas price: %w", err)
		}
		unsigned = &types.LegacyTx{Nonce: nonce, GasPrice: price, Gas: gas, To: &to, Value: value, Data: data}
	}
	return types.SignNewTx(p.key, types.LatestSignerForChainID(chainID), unsigned)
}

// waitForReceipt polls until the transaction is mined (one confirmation).
func waitForReceipt(ctx context.Context, client *ethclient.Client, hash common.Hash) (*types.Receipt, error) {
	ctx, cancel := context.WithTimeout(ctx, receiptTimeout)
	defer cancel()
	ticker := time.NewTicker(receiptPoll)
	defer ticker.Stop()
	for {
		receipt, err := client.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, fmt.Errorf("waiting for %s: %w", hash.Hex(), err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("waiting for %s: %w", hash.Hex(), ctx.Err())
		case <-ticker.C:
		}
	}
}
