// Package autopay keeps an Unaligned balance topped up: it checks the balance, asks the Payments API for an
// invoice, pays it from a wallet you control and follows it until it is credited.
package autopay

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// DefaultAPI is the public API base URL.
const DefaultAPI = "https://api.unaligned.pw/v1"

// TronMessage is the error for the one network this example does not support.
const TronMessage = "Tron is not supported by this example yet"

// ConfigError is a problem with the environment.
type ConfigError struct{ Message string }

func (e *ConfigError) Error() string { return e.Message }

func configErrorf(format string, args ...any) error {
	return &ConfigError{Message: fmt.Sprintf(format, args...)}
}

// Env looks an environment variable up: the empty string when it is unset.
type Env func(name string) string

// Method is one entry of GET /payments/methods.
type Method struct {
	Coin    string   `json:"coin"`
	Network string   `json:"network"`
	Kind    string   `json:"kind"` // invoice or deposit
	MinUSD  float64  `json:"min_usd"`
	MaxUSD  *float64 `json:"max_usd"` // nil for deposit methods
}

// Settings is everything that can be read without asking the API.
type Settings struct {
	Key     string
	API     string
	Network string
	Coin    string

	ThresholdUSD float64
	TopupUSD     int64
	MaxPerDayUSD int64
	// CheckInterval is in seconds.
	CheckInterval int
	DryRun        bool
	RefundAddress string
	StateFile     string
	TokenAddress  string
}

// Config is Settings plus the payment method, which needs the API.
type Config struct {
	Key           string
	API           string
	Network       string
	Coin          string
	Method        Method
	ThresholdUSD  float64
	TopupUSD      int64
	MaxPerDayUSD  int64
	CheckInterval int // seconds
	DryRun        bool
	RefundAddress string
	StateFile     string
	TokenAddress  string
}

// WalletVars lists the environment variables each network needs.
var WalletVars = map[string][]string{
	"ethereum": {"EVM_RPC_URL", "EVM_PRIVATE_KEY"},
	"bsc":      {"EVM_RPC_URL", "EVM_PRIVATE_KEY"},
	"solana":   {"SOLANA_RPC_URL", "SOLANA_PRIVATE_KEY"},
	"bitcoin":  {"WALLET_RPC_URL", "WALLET_RPC_USER", "WALLET_RPC_PASSWORD"},
	"litecoin": {"WALLET_RPC_URL", "WALLET_RPC_USER", "WALLET_RPC_PASSWORD"},
	"monero":   {"MONERO_WALLET_RPC_URL"},
}

// NativeCoin is the coin each network's own currency is called. Every other coin is a token.
var NativeCoin = map[string]string{
	"ethereum": "ETH",
	"bsc":      "BNB",
	"solana":   "SOL",
	"bitcoin":  "BTC",
	"litecoin": "LTC",
	"monero":   "XMR",
}

// APIBase is UNALIGNED_API or the public default, without a trailing slash.
func APIBase(env Env) string {
	base := env("UNALIGNED_API")
	if base == "" {
		base = DefaultAPI
	}
	return strings.TrimRight(base, "/")
}

// Preflight checks everything that needs no network. Run it before any call.
func Preflight(env Env) (Settings, error) {
	var s Settings
	var err error
	if s.Key, err = required(env, "UNALIGNED_KEY"); err != nil {
		return s, err
	}
	network, err := required(env, "NETWORK")
	if err != nil {
		return s, err
	}
	coin, err := required(env, "COIN")
	if err != nil {
		return s, err
	}
	s.Network, s.Coin = strings.ToLower(network), strings.ToUpper(coin)
	if s.Network == "tron" {
		return s, &ConfigError{Message: TronMessage}
	}

	threshold, err := required(env, "THRESHOLD_USD")
	if err != nil {
		return s, err
	}
	if s.ThresholdUSD, err = parseNumber(threshold); err != nil || s.ThresholdUSD <= 0 {
		return s, configErrorf("THRESHOLD_USD must be a number above 0")
	}
	if s.TopupUSD, err = wholeNumber(env, "TOPUP_USD"); err != nil {
		return s, err
	}
	if s.MaxPerDayUSD, err = wholeNumber(env, "MAX_PER_DAY_USD"); err != nil {
		return s, err
	}
	if s.MaxPerDayUSD < s.TopupUSD {
		return s, configErrorf("MAX_PER_DAY_USD must be at least TOPUP_USD")
	}

	interval := env("CHECK_INTERVAL")
	if interval == "" {
		interval = "60"
	}
	seconds, err := parseNumber(interval)
	if err != nil || seconds != math.Trunc(seconds) || seconds < 15 || seconds > math.MaxInt32 {
		return s, configErrorf("CHECK_INTERVAL must be a whole number of seconds, at least 15")
	}
	s.CheckInterval = int(seconds)

	s.TokenAddress = env("TOKEN_ADDRESS")
	if s.TokenAddress != "" && NativeCoin[s.Network] == s.Coin {
		return s, configErrorf("TOKEN_ADDRESS is for tokens: %s is the native coin of %s, unset TOKEN_ADDRESS", s.Coin, s.Network)
	}
	for _, name := range WalletVars[s.Network] {
		if _, err := required(env, name); err != nil {
			return s, err
		}
	}

	s.API = APIBase(env)
	s.DryRun = env("DRY_RUN") == "1"
	s.RefundAddress = env("REFUND_ADDRESS")
	if s.StateFile = env("STATE_FILE"); s.StateFile == "" {
		s.StateFile = "./autopay-state.json"
	}
	return s, nil
}

// LoadConfig reads and validates the environment. methods is the answer of GET /payments/methods.
func LoadConfig(env Env, methods []Method) (Config, error) {
	s, err := Preflight(env)
	if err != nil {
		return Config{}, err
	}
	var method *Method
	for i := range methods {
		if methods[i].Network == s.Network && methods[i].Coin == s.Coin {
			method = &methods[i]
			break
		}
	}
	if method == nil {
		pairs := make([]string, len(methods))
		for i, m := range methods {
			pairs[i] = m.Coin + "/" + m.Network
		}
		return Config{}, configErrorf("%s on %s is not offered. Valid COIN/NETWORK pairs: %s",
			s.Coin, s.Network, strings.Join(pairs, ", "))
	}
	if float64(s.TopupUSD) < method.MinUSD {
		return Config{}, configErrorf("TOPUP_USD must be at least %s for %s on %s", formatNumber(method.MinUSD), s.Coin, s.Network)
	}
	if method.MaxUSD != nil && float64(s.TopupUSD) > *method.MaxUSD {
		return Config{}, configErrorf("TOPUP_USD must be at most %s for %s on %s", formatNumber(*method.MaxUSD), s.Coin, s.Network)
	}
	return Config{
		Key: s.Key, API: s.API, Network: s.Network, Coin: s.Coin, Method: *method,
		ThresholdUSD: s.ThresholdUSD, TopupUSD: s.TopupUSD, MaxPerDayUSD: s.MaxPerDayUSD,
		CheckInterval: s.CheckInterval, DryRun: s.DryRun, RefundAddress: s.RefundAddress,
		StateFile: s.StateFile, TokenAddress: s.TokenAddress,
	}, nil
}

func required(env Env, name string) (string, error) {
	value := env(name)
	if value == "" {
		return "", configErrorf("%s is required", name)
	}
	return value, nil
}

var digitsOnly = regexp.MustCompile(`^\d+$`)

func wholeNumber(env Env, name string) (int64, error) {
	text, err := required(env, name)
	if err != nil {
		return 0, err
	}
	n, parseErr := strconv.ParseInt(text, 10, 64)
	if !digitsOnly.MatchString(text) || parseErr != nil {
		return 0, configErrorf("%s must be a whole number of dollars", name)
	}
	return n, nil
}

// parseNumber reads a finite decimal number.
func parseNumber(text string) (float64, error) {
	n, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, fmt.Errorf("not a number: %q", text)
	}
	return n, nil
}

// formatNumber prints a USD figure without a needless ".0".
func formatNumber(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }
