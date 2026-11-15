package autopay

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
)

// apiServer answers like the Unaligned API for a handful of paths and remembers the last Authorization header.
func apiServer(t *testing.T) (base string, lastAuth func() string) {
	t.Helper()
	var mu sync.Mutex
	auth := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auth = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch path := r.URL.Path; {
		case strings.HasSuffix(path, "/garbage"):
			_, _ = w.Write([]byte("<html>"))
		case strings.HasSuffix(path, "/cut"):
			// Promises more than it sends, then drops the connection.
			w.Header().Set("Content-Length", "100")
			_, _ = w.Write([]byte(`{"balance"`))
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		case strings.HasPrefix(path, "/odd/"):
			// A 2xx body that is not the documented answer.
			bodies := map[string]string{
				"/odd/empty/balance": `{}`, "/odd/null/balance": `null`,
				"/odd/text/balance": `{"balance":"12.5"}`, "/odd/infinite/balance": `{"balance":1e999}`,
				"/odd/bare/payments/methods": `[]`, "/odd/null/payments/methods": `null`,
				"/odd/empty/payments/methods": `{}`,
			}
			_, _ = w.Write([]byte(bodies[path]))
		case path == "/balance":
			_, _ = w.Write([]byte(`{"balance": 12.5}`))
		case path == "/payments/methods":
			_, _ = w.Write([]byte(`{"methods":[{"coin":"USDT","network":"bsc","kind":"invoice","min_usd":5.0,` +
				`"max_usd":50000.0,"rate_usd":1.0,"confirmations":15}]}`))
		case path == "/payments/inv-1" || path == "/payments":
			// What the API answers: snake_case, seconds.
			_, _ = w.Write([]byte(`{"kind":"invoice","id":"inv-1","coin":"USDT","network":"bsc","amount_usd":50.0,` +
				`"amount_crypto":"50.00","address":"0xa","created_at":1793925000,"expires_at":1793926800,` +
				`"required_confirmations":15,"status":"waiting","payments":[]}`))
		case path == "/payments/deposit/solana":
			_, _ = w.Write([]byte(`{"kind":"deposit","network":"solana","coins":["USDT","USDC"],"address":"A",` +
				`"min_usd":1.0,"required_confirmations":1,"deposits":[{"coin":"USDT","amount":"5","usd":5.0,` +
				`"tx_hash":"t1","at":1793925000,"confirmations":3,"credited":true}]}`))
		case strings.HasSuffix(path, "/full"):
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":{"code":"limit_reached","message":"too many open"}}`))
		case strings.HasSuffix(path, "/limited"):
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":"rate_limited","message":"slow"}}`))
		default:
			w.Header().Set("X-Request-Id", "req_1")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_request","message":"nope","request_id":"req_1"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() string { mu.Lock(); defer mu.Unlock(); return auth }
}

func asAPIError(t *testing.T, err error) *APIError {
	t.Helper()
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected an APIError, got %T: %v", err, err)
	}
	return apiErr
}

func TestBalanceSendsTheKeyAsABearerToken(t *testing.T) {
	base, lastAuth := apiServer(t)
	balance, err := NewAPI(base, "secret").Balance(context.Background())
	if err != nil || balance != 12.5 {
		t.Fatalf("Balance = %v, %v", balance, err)
	}
	if lastAuth() != "Bearer secret" {
		t.Errorf("Authorization = %q", lastAuth())
	}
}

func TestMethodsIsPublicNoAuthorizationHeader(t *testing.T) {
	base, lastAuth := apiServer(t)
	methods, err := NewAPI(base, "secret").Methods(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if lastAuth() != "" {
		t.Errorf("Authorization = %q, want none", lastAuth())
	}
	if len(methods) != 1 || methods[0].MinUSD != 5 || methods[0].MaxUSD == nil || *methods[0].MaxUSD != 50000 {
		t.Errorf("methods = %+v", methods)
	}
}

func TestAnInvoiceIsReadFromSnakeCaseItsSecondsBecomeMilliseconds(t *testing.T) {
	base, _ := apiServer(t)
	want := Invoice{
		Kind: "invoice", ID: "inv-1", Coin: "USDT", Network: "bsc", AmountUSD: 50, AmountCrypto: "50.00",
		Address: "0xa", CreatedAt: 1793925000000, ExpiresAt: 1793926800000, Status: "waiting",
	}
	api := NewAPI(base, "k")
	if got, err := api.GetPayment(context.Background(), "inv-1"); err != nil || got != want {
		t.Errorf("GetPayment = %+v, %v", got, err)
	}
	got, err := api.CreateInvoice(context.Background(), CreateRequest{AmountUSD: 50, Coin: "USDT", Network: "bsc"})
	if err != nil || got != want {
		t.Errorf("CreateInvoice = %+v, %v", got, err)
	}
}

func TestADepositAddressIsReadWithItsDepositsByTxHash(t *testing.T) {
	base, _ := apiServer(t)
	deposit, err := NewAPI(base, "k").Deposit(context.Background(), "solana")
	if err != nil {
		t.Fatal(err)
	}
	if deposit.Network != "solana" || deposit.Address != "A" || !slices.Equal(deposit.Coins, []string{"USDT", "USDC"}) ||
		!slices.Equal(deposit.Deposits, []DepositEntry{{TxHash: "t1", Credited: true}}) {
		t.Errorf("deposit = %+v", deposit)
	}
}

func TestA2xxMethodsAnswerWithoutAListIsATransientError(t *testing.T) {
	base, _ := apiServer(t)
	for _, odd := range []string{"bare", "null", "empty"} {
		_, err := NewAPI(base+"/odd/"+odd, "k").Methods(context.Background())
		if err == nil {
			t.Errorf("%s: no error", odd)
			continue
		}
		if apiErr := asAPIError(t, err); !apiErr.Transient {
			t.Errorf("%s: not transient: %v", odd, err)
		}
	}
}

func TestA400CarriesTheAPIErrorCodeAndTheRequestIDAndIsNotTransient(t *testing.T) {
	base, _ := apiServer(t)
	_, err := NewAPI(base, "k").Deposit(context.Background(), "x")
	apiErr := asAPIError(t, err)
	if apiErr.Status != 400 || apiErr.Code != "invalid_request" || apiErr.Transient ||
		apiErr.Error() != "GET /payments/deposit/x: 400 invalid_request nope (request req_1)" {
		t.Errorf("unexpected error: %+v", apiErr)
	}
}

func TestA409TooManyOpenInvoicesIsNotTransient(t *testing.T) {
	base, _ := apiServer(t)
	_, err := NewAPI(base, "k").GetPayment(context.Background(), "full")
	apiErr := asAPIError(t, err)
	if apiErr.Status != 409 || apiErr.Code != "limit_reached" || apiErr.Transient {
		t.Errorf("unexpected error: %+v", apiErr)
	}
}

func TestA429IsTransient(t *testing.T) {
	base, _ := apiServer(t)
	_, err := NewAPI(base, "k").GetPayment(context.Background(), "limited")
	apiErr := asAPIError(t, err)
	if apiErr.Status != 429 || !apiErr.Transient {
		t.Errorf("unexpected error: %+v", apiErr)
	}
}

func TestANonJSONOrCutOff200BodyIsATransientError(t *testing.T) {
	base, _ := apiServer(t)
	for _, id := range []string{"garbage", "cut"} {
		_, err := NewAPI(base, "k").GetPayment(context.Background(), id)
		if apiErr := asAPIError(t, err); !apiErr.Transient {
			t.Errorf("%s: not transient: %+v", id, apiErr)
		}
	}
}

func TestARefusedConnectionIsATransientError(t *testing.T) {
	_, err := NewAPI("http://127.0.0.1:1", "k").Balance(context.Background())
	if apiErr := asAPIError(t, err); !apiErr.Transient {
		t.Errorf("not transient: %+v", apiErr)
	}
}

func TestA2xxBalanceWithoutAFiniteNumberIsATransientError(t *testing.T) {
	base, _ := apiServer(t)
	for _, odd := range []string{"empty", "null", "text", "infinite"} {
		_, err := NewAPI(base+"/odd/"+odd, "k").Balance(context.Background())
		if err == nil {
			t.Errorf("%s: no error", odd)
			continue
		}
		if apiErr := asAPIError(t, err); !apiErr.Transient {
			t.Errorf("%s: not transient: %v", odd, err)
		}
	}
}

func TestAnIncompleteInvoiceIsATransientErrorNeverAnInvoice(t *testing.T) {
	complete := map[string]any{
		"kind": "invoice", "id": "inv-1", "coin": "USDT", "network": "bsc", "amount_usd": 50.0,
		"amount_crypto": "50.00", "address": "0xa", "created_at": 1793925000, "expires_at": 1793926800,
		"status": "waiting",
	}
	without := func(field string) map[string]any {
		body := maps.Clone(complete)
		delete(body, field)
		return body
	}
	with := func(field string, value any) map[string]any {
		body := maps.Clone(complete)
		body[field] = value
		return body
	}
	cases := []struct {
		name string
		body any
		ok   bool
	}{
		{"complete", complete, true},
		{"no id", without("id"), false},
		{"empty id", with("id", ""), false},
		{"no amount_crypto", without("amount_crypto"), false},
		{"empty amount_crypto", with("amount_crypto", ""), false},
		{"no address", without("address"), false},
		{"empty address", with("address", ""), false},
		{"no status", without("status"), false},
		{"empty status", with("status", ""), false},
		{"no expires_at", without("expires_at"), false},
		{"zero expires_at", with("expires_at", 0), false},
		{"negative expires_at", with("expires_at", -1), false},
		{"null", nil, false},
		{"empty object", map[string]any{}, false},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.Method == http.MethodPost {
				w.WriteHeader(http.StatusCreated)
			}
			_ = json.NewEncoder(w).Encode(c.body)
		}))
		api := NewAPI(srv.URL, "k")
		read, readErr := api.GetPayment(context.Background(), "inv-1")
		created, createErr := api.CreateInvoice(context.Background(), CreateRequest{AmountUSD: 50, Coin: "USDT", Network: "bsc"})
		srv.Close()
		for call, got := range map[string]struct {
			invoice Invoice
			err     error
		}{"GetPayment": {read, readErr}, "CreateInvoice": {created, createErr}} {
			if c.ok {
				if got.err != nil || got.invoice.ID != "inv-1" || got.invoice.ExpiresAt != 1793926800000 {
					t.Errorf("%s, %s = %+v, %v", c.name, call, got.invoice, got.err)
				}
				continue
			}
			if got.err == nil {
				t.Errorf("%s, %s: no error, invoice %+v", c.name, call, got.invoice)
				continue
			}
			if apiErr := asAPIError(t, got.err); !apiErr.Transient || !strings.Contains(apiErr.Message, "unreadable response") {
				t.Errorf("%s, %s: not a transient unreadable response: %v", c.name, call, got.err)
			}
			if got.invoice != (Invoice{}) {
				t.Errorf("%s, %s: an invoice came with the error: %+v", c.name, call, got.invoice)
			}
		}
	}
}
