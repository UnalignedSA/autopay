package payers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"github.com/UnalignedSA/autopay/go/autopay"
)

const utxoDecimals = 8

var leadingZeros = regexp.MustCompile(`^0+(\d)`)

// UtxoPayer is a Bitcoin Core / Litecoin Core wallet over JSON-RPC (sendtoaddress), with basic auth.
type UtxoPayer struct {
	url, user, password string
	client              *http.Client
}

// NewUtxoPayer builds the wallet client. The URL may include /wallet/<name>.
func NewUtxoPayer(url, user, password string) *UtxoPayer {
	return &UtxoPayer{url: url, user: user, password: password, client: walletHTTP()}
}

// Address is not used: the node's wallet holds the funds.
func (p *UtxoPayer) Address(context.Context) (string, error) { return "", errNoAddress }

// Send calls sendtoaddress. The amount reaches the node as the exact decimal digits.
func (p *UtxoPayer) Send(ctx context.Context, to, _ string, amount string) (string, error) {
	// Checks the string is a plain decimal with at most 8 decimals; the value itself is not used.
	if _, err := autopay.ToBaseUnits(amount, utxoDecimals); err != nil {
		return "", err
	}
	// json.Marshal of a float could change the digits, so the number literal is spliced into the text.
	// Leading zeros are not valid JSON and are dropped.
	literal := leadingZeros.ReplaceAllString(amount, "$1")
	address, _ := json.Marshal(to)
	body := fmt.Sprintf(`{"jsonrpc":"1.0","id":"autopay","method":"sendtoaddress","params":[%s,%s]}`, address, literal)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader([]byte(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(p.user, p.password)
	res, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("wallet RPC: %w", err)
	}
	defer res.Body.Close()
	// Bitcoin Core answers errors with HTTP 500 and a JSON body, so read the body first.
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return "", fmt.Errorf("wallet RPC: %w", err)
	}
	var answer struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(text, &answer); err != nil {
		return "", fmt.Errorf("wallet RPC answered HTTP %d", res.StatusCode)
	}
	if answer.Error != nil {
		return "", fmt.Errorf("wallet RPC error: %s", orUnknown(answer.Error.Message))
	}
	var txid string
	if json.Unmarshal(answer.Result, &txid) != nil || txid == "" {
		return "", fmt.Errorf("wallet RPC returned no transaction id")
	}
	return txid, nil
}

func orUnknown(message string) string {
	if message == "" {
		return "unknown"
	}
	return message
}
