package autopay

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
		case path == "/balance":
			_, _ = w.Write([]byte(`{"balance": 12.5}`))
		case path == "/payments/methods":
			_, _ = w.Write([]byte(`[{"coin":"USDT","network":"bsc","kind":"invoice","min_usd":5.0,"max_usd":50000.0}]`))
		case strings.HasSuffix(path, "/limited"):
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":"rate_limited","message":"slow"}}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"invalid_input","message":"nope"}}`))
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

func TestA400CarriesTheAPIErrorCodeAndIsNotTransient(t *testing.T) {
	base, _ := apiServer(t)
	_, err := NewAPI(base, "k").Deposit(context.Background(), "x")
	apiErr := asAPIError(t, err)
	if apiErr.Status != 400 || apiErr.Code != "invalid_input" || apiErr.Transient || !strings.Contains(apiErr.Error(), "nope") {
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
