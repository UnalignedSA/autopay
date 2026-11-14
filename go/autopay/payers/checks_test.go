package payers

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/gagliardetto/solana-go"

	"github.com/UnalignedSA/autopay/go/autopay"
)

// rpcNode is a JSON-RPC node that answers each method from answers (echoing the request id) and records the
// methods it was asked for.
func rpcNode(t *testing.T, answers map[string]any) (url string, methods func() []string) {
	t.Helper()
	var mu sync.Mutex
	var asked []string
	url, _ = stub(t, func(s seen, _ int) stubReply {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal([]byte(s.body), &req)
		mu.Lock()
		asked = append(asked, req.Method)
		mu.Unlock()
		answer := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if result, ok := answers[req.Method]; ok {
			answer["result"] = result
		} else {
			answer["error"] = map[string]any{"code": -32601, "message": "no"}
		}
		body, _ := json.Marshal(answer)
		return stubReply{status: 200, body: string(body)}
	})
	return url, func() []string { mu.Lock(); defer mu.Unlock(); return slices.Clone(asked) }
}

func TestEvmANodeOfTheOtherMainnetIsRefusedOtherChainIDsAreAllowed(t *testing.T) {
	var configErr *autopay.ConfigError
	if err := CheckChainID("bsc", big.NewInt(1)); !errors.As(err, &configErr) {
		t.Errorf("bsc on chain 1: %v", err)
	}
	if err := CheckChainID("ethereum", big.NewInt(56)); err == nil || !strings.Contains(err.Error(), "NETWORK is ethereum") {
		t.Errorf("ethereum on chain 56: %v", err)
	}
	for network, id := range map[string]int64{"ethereum": 1, "bsc": 56} {
		if err := CheckChainID(network, big.NewInt(id)); err != nil {
			t.Errorf("%s on its own chain: %v", network, err)
		}
	}
	for _, id := range []int64{31337, 97} {
		if err := CheckChainID("bsc", big.NewInt(id)); err != nil {
			t.Errorf("test chain %d: %v", id, err)
		}
	}
}

func TestEvmCheckAndSendRefuseAWrongNodeBeforeAnythingIsSigned(t *testing.T) {
	url, methods := rpcNode(t, map[string]any{"eth_chainId": "0x1"})
	payer, err := NewEvmPayer(EvmOptions{RPCURL: url, PrivateKey: testKey, Network: "bsc"})
	if err != nil {
		t.Fatal(err)
	}
	var configErr *autopay.ConfigError
	if err := payer.Check(context.Background()); !errors.As(err, &configErr) {
		t.Errorf("Check: %v", err)
	}
	if _, err := payer.Send(context.Background(), override, "BNB", "1"); err == nil ||
		!strings.Contains(err.Error(), "ethereum node (chain id 1)") {
		t.Errorf("Send: %v", err)
	}
	if asked := slices.Compact(methods()); !slices.Equal(asked, []string{"eth_chainId"}) {
		t.Errorf("methods = %v", asked)
	}
}

// flakyReceipts fails a few times, then answers "not found" a few times, then returns the receipt.
type flakyReceipts struct{ calls int }

func (f *flakyReceipts) TransactionReceipt(context.Context, common.Hash) (*types.Receipt, error) {
	f.calls++
	switch {
	case f.calls <= 2:
		return nil, errors.New("connection reset")
	case f.calls <= 4:
		return nil, ethereum.NotFound
	}
	return &types.Receipt{Status: types.ReceiptStatusSuccessful}, nil
}

type deadNode struct{}

func (deadNode) TransactionReceipt(context.Context, common.Hash) (*types.Receipt, error) {
	return nil, errors.New("connection refused")
}

func TestEvmTheReceiptIsAwaitedThroughRPCErrorsUntilTheTimeout(t *testing.T) {
	flaky := &flakyReceipts{}
	receipt, err := waitForReceipt(context.Background(), flaky, common.Hash{}, 5*time.Second, time.Millisecond)
	if err != nil || receipt.Status != types.ReceiptStatusSuccessful || flaky.calls != 5 {
		t.Fatalf("receipt %v, err %v, calls %d", receipt, err, flaky.calls)
	}
	_, err = waitForReceipt(context.Background(), deadNode{}, common.Hash{}, 20*time.Millisecond, time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("err = %v", err)
	}
}

func TestWalletRPCsHaveNoOverallTimeout(t *testing.T) {
	if c := NewMoneroPayer("http://127.0.0.1:1", "", "").client; c.Timeout != 0 {
		t.Errorf("monero timeout = %v", c.Timeout)
	}
	if c := NewUtxoPayer("http://127.0.0.1:1", "u", "p").client; c.Timeout != 0 {
		t.Errorf("utxo timeout = %v", c.Timeout)
	}
}

func TestSolanaAmountsAbove2To64Minus1AreRefusedNeverTruncated(t *testing.T) {
	max := new(big.Int).SetUint64(^uint64(0))
	if v, err := ToU64(max); err != nil || v != ^uint64(0) {
		t.Errorf("ToU64(max) = %d, %v", v, err)
	}
	if _, err := ToU64(new(big.Int).Add(max, big.NewInt(1))); err == nil || !strings.Contains(err.Error(), "64 bits") {
		t.Errorf("ToU64(max+1) err = %v", err)
	}
	payer := testSolanaPayer(t, "http://127.0.0.1:1", "")
	to := solana.NewWallet().PublicKey().String()
	if _, err := payer.Send(context.Background(), to, "SOL", "18446744073.709551616"); err == nil ||
		!strings.Contains(err.Error(), "64 bits") {
		t.Errorf("Send err = %v", err)
	}
}

// mintAccount is a getAccountInfo answer for an SPL mint: decimals at byte 44, is_initialized at 45.
func mintAccount(owner solana.PublicKey, decimals byte, initialized bool) map[string]any {
	data := make([]byte, 82)
	data[44] = decimals
	if initialized {
		data[45] = 1
	}
	return map[string]any{
		"context": map[string]any{"slot": 1},
		"value": map[string]any{
			"data": []string{base64.StdEncoding.EncodeToString(data), "base64"}, "executable": false,
			"lamports": 1_000_000, "owner": owner.String(), "rentEpoch": 0, "space": 82,
		},
	}
}

func testSolanaPayer(t *testing.T, url, tokenAddress string) *SolanaPayer {
	t.Helper()
	payer, err := NewSolanaPayer(url, solana.NewWallet().PrivateKey.String(), tokenAddress)
	if err != nil {
		t.Fatal(err)
	}
	return payer
}

func TestSolanaAMintThatIsNotATokenMintOrNotInitializedIsNeverPaid(t *testing.T) {
	mint := solana.NewWallet().PublicKey().String()
	recipient := solana.NewWallet().PublicKey()
	for _, tc := range []struct {
		account map[string]any
		want    string
	}{
		{mintAccount(solana.SystemProgramID, 6, true), "not a token mint"},
		{mintAccount(solana.TokenProgramID, 6, false), "not initialized"},
	} {
		url, methods := rpcNode(t, map[string]any{"getAccountInfo": tc.account})
		payer := testSolanaPayer(t, url, mint)
		if _, err := payer.Send(context.Background(), recipient.String(), "USDT", "1"); err == nil ||
			!strings.Contains(err.Error(), tc.want) {
			t.Errorf("want %q, got %v", tc.want, err)
		}
		if slices.Contains(methods(), "sendTransaction") {
			t.Errorf("a transaction was sent: %v", methods())
		}
	}
}

func TestSolanaTheHandBuiltTransferCheckedGoesToTheMintsProgram(t *testing.T) {
	mint := solana.NewWallet().PublicKey().String()
	recipient := solana.NewWallet().PublicKey()
	for _, program := range []solana.PublicKey{solana.TokenProgramID, solana.Token2022ProgramID} {
		url, _ := rpcNode(t, map[string]any{"getAccountInfo": mintAccount(program, 6, true)})
		payer := testSolanaPayer(t, url, mint)
		instructions, err := payer.tokenTransfer(context.Background(), mint, recipient, "1.5")
		if err != nil || len(instructions) != 2 {
			t.Fatalf("instructions %v, err %v", instructions, err)
		}
		transfer := instructions[1]
		data, _ := transfer.Data()
		want := make([]byte, 10)
		want[0] = transferCheckedCode
		binary.LittleEndian.PutUint64(want[1:9], 1_500_000)
		want[9] = 6
		if !transfer.ProgramID().Equals(program) || !slices.Equal(data, want) || len(transfer.Accounts()) != 4 {
			t.Errorf("program %s, data %v", transfer.ProgramID(), data)
		}
	}
}
