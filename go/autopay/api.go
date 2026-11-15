package autopay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Invoice is a payment to make to a one-off address.
type Invoice struct {
	Kind         string  `json:"kind"`
	ID           string  `json:"id"`
	Coin         string  `json:"coin"`
	Network      string  `json:"network"`
	AmountUSD    float64 `json:"amount_usd"`
	AmountCrypto string  `json:"amount_crypto"`
	Address      string  `json:"address"`
	// CreatedAt and ExpiresAt are milliseconds since 1970, like every time in the program. The API gives seconds.
	CreatedAt int64 `json:"created_at"`
	ExpiresAt int64 `json:"expires_at"`
	// Status is waiting, confirming, partial, paid, expired or refunded.
	Status string `json:"status"`
}

// DepositEntry is one payment seen on the account's deposit address.
type DepositEntry struct {
	TxHash   string `json:"tx_hash"`
	Credited bool   `json:"credited"`
}

// Deposit is the account's fixed deposit address on a network.
type Deposit struct {
	Kind     string         `json:"kind"`
	Network  string         `json:"network"`
	Coins    []string       `json:"coins"`
	Address  string         `json:"address"`
	Deposits []DepositEntry `json:"deposits"`
}

// CreateRequest is the body of POST /payments. A deposit method leaves AmountUSD out.
type CreateRequest struct {
	AmountUSD     int64  `json:"amount_usd,omitempty"`
	Coin          string `json:"coin"`
	Network       string `json:"network"`
	RefundAddress string `json:"refund_address,omitempty"`
}

// API is the part of the Unaligned API that Step uses. *Client implements it; tests use a fake.
type API interface {
	Balance(ctx context.Context) (float64, error)
	CreateInvoice(ctx context.Context, req CreateRequest) (Invoice, error)
	CreateDeposit(ctx context.Context, req CreateRequest) (Deposit, error)
	GetPayment(ctx context.Context, id string) (Invoice, error)
	Deposit(ctx context.Context, network string) (Deposit, error)
}

// APIError is a failed API call.
type APIError struct {
	// Status is the HTTP status, 0 for a network error.
	Status  int
	Code    string
	Message string
	// Transient is true for failures that may go away by themselves: network errors, 5xx and 429.
	Transient bool
}

func (e *APIError) Error() string { return e.Message }

// Client talks to the Unaligned API.
type Client struct {
	base, key string
	http      *http.Client
}

// NewAPI returns a client for the base URL (no trailing slash) and API key.
func NewAPI(base, key string) *Client {
	return &Client{base: base, key: key, http: &http.Client{Timeout: 30 * time.Second}}
}

// Balance is the account balance in USD.
func (c *Client) Balance(ctx context.Context) (float64, error) {
	// A pointer, so that a missing balance is told apart from a zero one.
	var body *struct {
		Balance *float64 `json:"balance"`
	}
	if err := c.request(ctx, http.MethodGet, "/balance", nil, true, &body); err != nil {
		return 0, err
	}
	// A 2xx without a usable number is a glitch, never a zero balance.
	if body == nil || body.Balance == nil || math.IsInf(*body.Balance, 0) || math.IsNaN(*body.Balance) {
		return 0, &APIError{Status: http.StatusOK, Message: "GET /balance: the answer has no balance", Transient: true}
	}
	return *body.Balance, nil
}

// Methods lists the payment methods. It is public: sent without the key.
func (c *Client) Methods(ctx context.Context) ([]Method, error) {
	var body *struct {
		Methods []Method `json:"methods"`
	}
	if err := c.request(ctx, http.MethodGet, "/payments/methods", nil, false, &body); err != nil {
		return nil, err
	}
	// A 2xx without the list is a glitch, never "nothing is offered".
	if body == nil || body.Methods == nil {
		return nil, &APIError{Status: http.StatusOK, Message: "GET /payments/methods: the answer has no methods", Transient: true}
	}
	return body.Methods, nil
}

// CreateInvoice answers 201 with an invoice.
func (c *Client) CreateInvoice(ctx context.Context, req CreateRequest) (Invoice, error) {
	return c.invoice(ctx, http.MethodPost, "/payments", req)
}

// invoice reads an invoice and turns the API's seconds into milliseconds.
func (c *Client) invoice(ctx context.Context, method, path string, body any) (Invoice, error) {
	var invoice Invoice
	err := c.request(ctx, method, path, body, true, &invoice)
	invoice.CreatedAt *= 1000
	invoice.ExpiresAt *= 1000
	return invoice, err
}

// CreateDeposit answers 200 with the account's fixed deposit address.
func (c *Client) CreateDeposit(ctx context.Context, req CreateRequest) (Deposit, error) {
	var deposit Deposit
	err := c.request(ctx, http.MethodPost, "/payments", req, true, &deposit)
	return deposit, err
}

// GetPayment reads an invoice.
func (c *Client) GetPayment(ctx context.Context, id string) (Invoice, error) {
	return c.invoice(ctx, http.MethodGet, "/payments/"+url.PathEscape(id), nil)
}

// Deposit reads the deposit address and its payments.
func (c *Client) Deposit(ctx context.Context, network string) (Deposit, error) {
	var deposit Deposit
	err := c.request(ctx, http.MethodGet, "/payments/deposit/"+url.PathEscape(network), nil, true, &deposit)
	return deposit, err
}

func (c *Client) request(ctx context.Context, method, path string, body any, auth bool, out any) error {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, payload)
	if err != nil {
		return &APIError{Message: fmt.Sprintf("%s %s: %v", method, path, err)}
	}
	req.Header.Set("Content-Type", "application/json")
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return &APIError{Message: "network error: " + err.Error(), Transient: true}
	}
	defer res.Body.Close()
	text, readErr := io.ReadAll(res.Body)

	if res.StatusCode >= 200 && res.StatusCode < 300 {
		if readErr == nil {
			readErr = json.Unmarshal(text, out)
		}
		if readErr != nil {
			// The body was cut off or is not JSON: treat it like any other glitch and try again later.
			return &APIError{
				Status:    res.StatusCode,
				Message:   fmt.Sprintf("%s %s: unreadable response: %v", method, path, readErr),
				Transient: true,
			}
		}
		return nil
	}

	var failure struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	message := http.StatusText(res.StatusCode)
	if json.Unmarshal(text, &failure) == nil && failure.Error.Message != "" {
		message = failure.Error.Message
	}
	// The request id is what support asks for.
	requestID := res.Header.Get("X-Request-Id")
	if requestID != "" {
		requestID = "(request " + requestID + ")"
	}
	parts := []string{method + " " + path + ":", strconv.Itoa(res.StatusCode), failure.Error.Code, message, requestID}
	var kept []string
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return &APIError{
		Status:  res.StatusCode,
		Code:    failure.Error.Code,
		Message: strings.Join(kept, " "),
		// 429 means slow down, not give up.
		Transient: res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests,
	}
}
