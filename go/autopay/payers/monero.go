package payers

import (
	"context"
	"crypto/md5" //nolint:gosec // HTTP Digest authentication is defined with MD5 (RFC 7616)
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/UnalignedSA/autopay/go/autopay"
)

const moneroDecimals = 12

// MoneroPayer is monero-wallet-rpc `transfer`. Digest authentication is used only when a user is set.
type MoneroPayer struct {
	url, user, password string
	client              *http.Client
}

// NewMoneroPayer builds the wallet client. user and password are optional.
func NewMoneroPayer(url, user, password string) *MoneroPayer {
	return &MoneroPayer{url: url, user: user, password: password, client: walletHTTP()}
}

// Address is not used: the wallet holds the funds.
func (p *MoneroPayer) Address(context.Context) (string, error) { return "", errNoAddress }

// Send transfers the amount, in atomic units (12 decimals), to the address.
func (p *MoneroPayer) Send(ctx context.Context, to, _ string, amount string) (string, error) {
	atomic, err := autopay.ToBaseUnits(amount, moneroDecimals)
	if err != nil {
		return "", err
	}
	// The amount is an integer in atomic units, written into the JSON as text.
	address, _ := json.Marshal(to)
	body := fmt.Sprintf(
		`{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"destinations":[{"amount":%s,"address":%s}],"priority":0}}`,
		atomic, address)

	res, text, err := p.post(ctx, body, "")
	if err != nil {
		return "", err
	}
	challenge := res.Header.Get("WWW-Authenticate")
	if res.StatusCode == http.StatusUnauthorized && p.user != "" && strings.HasPrefix(strings.ToLower(challenge), "digest") {
		u, err := url.Parse(p.url)
		if err != nil {
			return "", err
		}
		res, text, err = p.post(ctx, body, digestHeader(challenge, p.user, p.password, http.MethodPost, u.RequestURI()))
		if err != nil {
			return "", err
		}
	}
	if res.StatusCode == http.StatusUnauthorized {
		return "", fmt.Errorf("wallet RPC refused the credentials")
	}
	var answer struct {
		Result *struct {
			TxHash string `json:"tx_hash"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(text, &answer); err != nil {
		return "", fmt.Errorf("wallet RPC answered HTTP %d with a body that is not JSON", res.StatusCode)
	}
	if answer.Error != nil {
		return "", fmt.Errorf("wallet RPC error: %s", orUnknown(answer.Error.Message))
	}
	if answer.Result == nil || answer.Result.TxHash == "" {
		return "", fmt.Errorf("wallet RPC returned no transaction hash")
	}
	return answer.Result.TxHash, nil
}

func (p *MoneroPayer) post(ctx context.Context, body, authorization string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, strings.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	res, err := p.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("wallet RPC: %w", err)
	}
	defer res.Body.Close()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("wallet RPC: %w", err)
	}
	return res, text, nil
}

var challengeField = regexp.MustCompile(`(\w+)=(?:"([^"]*)"|([^,\s]+))`)

// parseChallenge reads key=value pairs (quoted or not) out of a `WWW-Authenticate: Digest ...` header.
func parseChallenge(header string) map[string]string {
	fields := map[string]string{}
	rest := strings.TrimSpace(header)
	if len(rest) >= 6 && strings.EqualFold(rest[:6], "digest") {
		rest = rest[6:]
	}
	for _, m := range challengeField.FindAllStringSubmatch(rest, -1) {
		fields[m[1]] = m[2] + m[3]
	}
	return fields
}

func md5hex(text string) string {
	sum := md5.Sum([]byte(text)) //nolint:gosec // see the import
	return hex.EncodeToString(sum[:])
}

// digestHeader is the Authorization header answering a Digest challenge (RFC 7616, MD5, qop=auth).
func digestHeader(challenge, user, password, method, uri string) string {
	c := parseChallenge(challenge)
	const nc = "00000001"
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	cnonce := hex.EncodeToString(raw)
	ha1 := md5hex(user + ":" + c["realm"] + ":" + password)
	ha2 := md5hex(method + ":" + uri)
	response := md5hex(strings.Join([]string{ha1, c["nonce"], nc, cnonce, "auth", ha2}, ":"))
	parts := []string{
		fmt.Sprintf("username=%q", user),
		fmt.Sprintf("realm=%q", c["realm"]),
		fmt.Sprintf("nonce=%q", c["nonce"]),
		fmt.Sprintf("uri=%q", uri),
		"algorithm=MD5",
		"qop=auth",
		"nc=" + nc,
		fmt.Sprintf("cnonce=%q", cnonce),
		fmt.Sprintf("response=%q", response),
	}
	if c["opaque"] != "" {
		parts = append(parts, fmt.Sprintf("opaque=%q", c["opaque"]))
	}
	return "Digest " + strings.Join(parts, ", ")
}
