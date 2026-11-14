package payers

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/gagliardetto/solana-go"
)

// seen is one request the stub received.
type seen struct{ body, auth string }

type stubReply struct {
	status  int
	headers map[string]string
	body    string
}

// stub is a tiny HTTP server that records requests and answers through reply (called with the 1-based count).
func stub(t *testing.T, reply func(s seen, count int) stubReply) (url string, requests func() []seen) {
	t.Helper()
	var mu sync.Mutex
	var got []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		got = append(got, seen{string(body), r.Header.Get("Authorization")})
		s, count := got[len(got)-1], len(got)
		mu.Unlock()
		rep := reply(s, count)
		w.Header().Set("Content-Type", "application/json")
		for k, v := range rep.headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(rep.status)
		_, _ = io.WriteString(w, rep.body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() []seen { mu.Lock(); defer mu.Unlock(); return append([]seen(nil), got...) }
}

func ok(body string) func(seen, int) stubReply {
	return func(seen, int) stubReply { return stubReply{status: 200, body: body} }
}

func TestUtxoSplicesTheAmountIntoTheJSONAsARawNumberLiteral(t *testing.T) {
	url, requests := stub(t, ok(`{"result":"abc123","error":null,"id":"autopay"}`))
	txid, err := NewUtxoPayer(url, "user", "pass").Send(context.Background(), "bcrt1qexample", "BTC", "0.00012345")
	if err != nil || txid != "abc123" {
		t.Fatalf("Send = %q, %v", txid, err)
	}
	got := requests()[0]
	if !strings.Contains(got.body, `"params":["bcrt1qexample",0.00012345]`) {
		t.Errorf("body = %s", got.body)
	}
	if want := "Basic dXNlcjpwYXNz"; got.auth != want {
		t.Errorf("auth = %q, want %q", got.auth, want)
	}
}

func TestUtxoAWholeAmountAndALeadingZeroStayValidJSONBadAmountsAreRefused(t *testing.T) {
	url, requests := stub(t, ok(`{"result":"t","error":null}`))
	p := NewUtxoPayer(url, "u", "p")
	ctx := context.Background()
	for _, amount := range []string{"50", "007.50", "0.5"} {
		if _, err := p.Send(ctx, "addr", "BTC", amount); err != nil {
			t.Fatalf("%s: %v", amount, err)
		}
	}
	for i, want := range []string{`"params":["addr",50]`, `"params":["addr",7.50]`, `"params":["addr",0.5]`} {
		body := requests()[i].body
		if !strings.Contains(body, want) || !json.Valid([]byte(body)) {
			t.Errorf("body %d = %s, want %s", i, body, want)
		}
	}
	for _, bad := range []string{"1e3", "0.123456789"} {
		if _, err := p.Send(ctx, "addr", "BTC", bad); err == nil {
			t.Errorf("%s should be refused", bad)
		}
	}
	if len(requests()) != 3 {
		t.Errorf("%d requests, want 3", len(requests()))
	}
}

func TestUtxoAnRPCErrorIsReturned(t *testing.T) {
	url, _ := stub(t, func(seen, int) stubReply {
		return stubReply{status: 500, body: `{"result":null,"error":{"code":-6,"message":"Insufficient funds"}}`}
	})
	_, err := NewUtxoPayer(url, "u", "p").Send(context.Background(), "a", "BTC", "1")
	if err == nil || !strings.Contains(err.Error(), "Insufficient funds") {
		t.Fatalf("err = %v", err)
	}
}

func TestMoneroTheAmountIsAnIntegerInAtomicUnitsNoAuthWithoutAUser(t *testing.T) {
	url, requests := stub(t, ok(`{"id":"0","jsonrpc":"2.0","result":{"tx_hash":"deadbeef"}}`))
	txid, err := NewMoneroPayer(url+"/json_rpc", "", "").Send(context.Background(), "44Addr", "XMR", "1.5")
	if err != nil || txid != "deadbeef" {
		t.Fatalf("Send = %q, %v", txid, err)
	}
	got := requests()
	if len(got) != 1 || got[0].auth != "" {
		t.Fatalf("requests = %+v", got)
	}
	if !strings.Contains(got[0].body, `"amount":1500000000000`) {
		t.Errorf("body = %s", got[0].body)
	}
	var sent struct {
		Method string `json:"method"`
		Params struct {
			Destinations []map[string]any `json:"destinations"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(got[0].body), &sent); err != nil || sent.Method != "transfer" {
		t.Fatalf("body = %s (%v)", got[0].body, err)
	}
	if d := sent.Params.Destinations; len(d) != 1 || d[0]["amount"] != float64(1500000000000) || d[0]["address"] != "44Addr" {
		t.Errorf("destinations = %v", d)
	}
}

func md5Of(text string) string {
	sum := md5.Sum([]byte(text))
	return hex.EncodeToString(sum[:])
}

func TestMoneroDigestAuthAnswersTheChallengeWhenAUserIsSet(t *testing.T) {
	const challenge = `Digest realm="wallet", qop="auth", nonce="n0nce", algorithm=MD5`
	field := func(header, key string) string {
		m := regexp.MustCompile(key + `=(?:"([^"]*)"|([^,\s]+))`).FindStringSubmatch(header)
		if m == nil {
			return ""
		}
		return m[1] + m[2]
	}
	url, requests := stub(t, func(s seen, _ int) stubReply {
		if s.auth == "" {
			return stubReply{status: 401, headers: map[string]string{"WWW-Authenticate": challenge}, body: "{}"}
		}
		ha1 := md5Of("alice:wallet:secret")
		ha2 := md5Of("POST:/json_rpc")
		want := md5Of(fmt.Sprintf("%s:n0nce:%s:%s:auth:%s", ha1, field(s.auth, "nc"), field(s.auth, "cnonce"), ha2))
		if field(s.auth, "response") == want && field(s.auth, "username") == "alice" && field(s.auth, "uri") == "/json_rpc" {
			return stubReply{status: 200, body: `{"result":{"tx_hash":"cafe"}}`}
		}
		return stubReply{status: 401, headers: map[string]string{"WWW-Authenticate": challenge}, body: "{}"}
	})
	txid, err := NewMoneroPayer(url+"/json_rpc", "alice", "secret").Send(context.Background(), "44A", "XMR", "2")
	if err != nil || txid != "cafe" {
		t.Fatalf("Send = %q, %v", txid, err)
	}
	if len(requests()) != 2 {
		t.Errorf("%d requests, want 2", len(requests()))
	}
}

func TestMoneroANonJSONErrorPageIsReportedClearly(t *testing.T) {
	url, _ := stub(t, func(seen, int) stubReply {
		return stubReply{status: 500, headers: map[string]string{"Content-Type": "text/html"}, body: "<html>oops</html>"}
	})
	_, err := NewMoneroPayer(url+"/json_rpc", "", "").Send(context.Background(), "44A", "XMR", "1")
	if err == nil || !regexp.MustCompile(`HTTP 500.*not JSON`).MatchString(err.Error()) {
		t.Fatalf("err = %v", err)
	}
}

const override = "0x1111111111111111111111111111111111111111"

var testKey = "0x" + strings.Repeat("11", 32)

func TestEvmTheERC20TransferABIHasNoOutputsEthereumUSDTReturnsNothing(t *testing.T) {
	transfer, ok := ERC20ABI.Methods["transfer"]
	if !ok || len(transfer.Outputs) != 0 {
		t.Fatalf("transfer = %+v", transfer)
	}
	payer, err := NewEvmPayer(EvmOptions{RPCURL: "http://127.0.0.1:1", PrivateKey: testKey, Network: "ethereum", TokenAddress: override})
	if err != nil {
		t.Fatal(err)
	}
	if token, err := payer.TokenFor("USDT"); err != nil || token != override {
		t.Errorf("TokenFor(USDT) = %q, %v", token, err)
	}
}

func TestEvmAddressIsDerivedFromTheKey(t *testing.T) {
	payer, err := NewEvmPayer(EvmOptions{RPCURL: "http://127.0.0.1:1", PrivateKey: testKey, Network: "bsc"})
	if err != nil {
		t.Fatal(err)
	}
	addr, _ := payer.Address(context.Background())
	if !regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`).MatchString(addr) {
		t.Errorf("address = %q", addr)
	}
	if token, err := payer.TokenFor("USDC"); err != nil || token != "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" {
		t.Errorf("TokenFor(USDC) = %q, %v", token, err)
	}
	if token, err := payer.TokenFor("BNB"); err != nil || token != "" {
		t.Errorf("TokenFor(BNB) = %q, %v", token, err)
	}
	if _, err := payer.TokenFor("DAI"); err == nil || !strings.Contains(err.Error(), "no token contract") {
		t.Errorf("TokenFor(DAI) err = %v", err)
	}
}

func TestEvmANativeCoinIsNeverATokenEvenWithTokenAddressAnUnknownCoinFails(t *testing.T) {
	eth, _ := NewEvmPayer(EvmOptions{RPCURL: "http://127.0.0.1:1", PrivateKey: testKey, Network: "ethereum", TokenAddress: override})
	if token, err := eth.TokenFor("ETH"); err != nil || token != "" {
		t.Errorf("TokenFor(ETH) = %q, %v", token, err)
	}
	plain, _ := NewEvmPayer(EvmOptions{RPCURL: "http://127.0.0.1:1", PrivateKey: testKey, Network: "ethereum"})
	if token, err := plain.TokenFor("ETH"); err != nil || token != "" {
		t.Errorf("TokenFor(ETH) = %q, %v", token, err)
	}
	if _, err := plain.TokenFor("DAI"); err == nil || !strings.Contains(err.Error(), "TOKEN_ADDRESS") {
		t.Errorf("TokenFor(DAI) err = %v", err)
	}
}

func TestSolanaSOLIsNativeEvenWithTokenAddressAnUnknownCoinFails(t *testing.T) {
	key := solana.NewWallet().PrivateKey
	var asNumbers []int
	for _, b := range key {
		asNumbers = append(asNumbers, int(b))
	}
	keyJSON, _ := json.Marshal(asNumbers)
	sol, err := NewSolanaPayer("http://127.0.0.1:1", string(keyJSON), override)
	if err != nil {
		t.Fatal(err)
	}
	if mint, err := sol.MintFor("SOL"); err != nil || mint != "" {
		t.Errorf("MintFor(SOL) = %q, %v", mint, err)
	}
	if mint, err := sol.MintFor("USDT"); err != nil || mint != override {
		t.Errorf("MintFor(USDT) = %q, %v", mint, err)
	}
	plain, _ := NewSolanaPayer("http://127.0.0.1:1", string(keyJSON), "")
	if mint, err := plain.MintFor("USDC"); err != nil || mint != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" {
		t.Errorf("MintFor(USDC) = %q, %v", mint, err)
	}
	if _, err := plain.MintFor("DAI"); err == nil || !strings.Contains(err.Error(), "TOKEN_ADDRESS") {
		t.Errorf("MintFor(DAI) err = %v", err)
	}
}

func TestSolanaTheKeyIsABase58SecretKeyOrAJSONByteArray(t *testing.T) {
	bytes := []byte(solana.NewWallet().PrivateKey)
	numbers := make([]int, 64)
	for i := range bytes {
		numbers[i] = int(bytes[i])
	}
	asJSON, _ := json.Marshal(numbers)
	fromJSON, err := ParseSolanaKey(string(asJSON))
	if err != nil || string(fromJSON) != string(bytes) {
		t.Fatalf("json key = %v, %v", fromJSON, err)
	}
	fromBase58, err := ParseSolanaKey(solana.PrivateKey(bytes).String())
	if err != nil || string(fromBase58) != string(bytes) {
		t.Fatalf("base58 key = %v, %v", fromBase58, err)
	}
	mismatched := append([]byte(nil), bytes...)
	mismatched[40] ^= 1
	mismatchedJSON, _ := json.Marshal(mismatched) // as base64 text: refused too
	for _, bad := range []string{"not a key!", "[1,2,3]", "[1,2,300]", string(mismatchedJSON), solana.PrivateKey(mismatched).String()} {
		if _, err := ParseSolanaKey(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestMakePayerPicksTheFamilyAndNamesAMissingVariable(t *testing.T) {
	none := func(string) string { return "" }
	if _, err := MakePayer("bsc", "", none); err == nil || !strings.Contains(err.Error(), "EVM_RPC_URL") {
		t.Errorf("bsc err = %v", err)
	}
	if _, err := MakePayer("tron", "", none); err == nil || !strings.Contains(err.Error(), "Tron") {
		t.Errorf("tron err = %v", err)
	}
	utxo := map[string]string{"WALLET_RPC_URL": "http://127.0.0.1:1", "WALLET_RPC_USER": "u", "WALLET_RPC_PASSWORD": "p"}
	if p, err := MakePayer("bitcoin", "", func(k string) string { return utxo[k] }); err != nil || p == nil {
		t.Errorf("bitcoin = %v, %v", p, err)
	}
	monero := map[string]string{"MONERO_WALLET_RPC_URL": "http://127.0.0.1:1"}
	if p, err := MakePayer("monero", "", func(k string) string { return monero[k] }); err != nil || p == nil {
		t.Errorf("monero = %v, %v", p, err)
	}
}
