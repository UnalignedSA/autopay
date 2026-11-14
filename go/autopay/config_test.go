package autopay

import (
	"errors"
	"strings"
	"testing"
)

var testMethods = []Method{
	{Coin: "USDT", Network: "bsc", Kind: "invoice", MinUSD: 5, MaxUSD: ptr(50000.0)},
	{Coin: "USDT", Network: "solana", Kind: "deposit", MinUSD: 1, MaxUSD: nil},
	{Coin: "BTC", Network: "bitcoin", Kind: "invoice", MinUSD: 5, MaxUSD: ptr(50000.0)},
}

func ptr[T any](v T) *T { return &v }

func baseEnv() map[string]string {
	return map[string]string{
		"UNALIGNED_KEY":   "key",
		"NETWORK":         "bsc",
		"COIN":            "USDT",
		"THRESHOLD_USD":   "10",
		"TOPUP_USD":       "50",
		"MAX_PER_DAY_USD": "100",
		"EVM_RPC_URL":     "http://localhost:8545",
		"EVM_PRIVATE_KEY": "0x01",
	}
}

// envWith returns the base environment with the given changes. An empty value removes the variable.
func envWith(changes map[string]string) Env {
	env := baseEnv()
	for k, v := range changes {
		if v == "" {
			delete(env, k)
		} else {
			env[k] = v
		}
	}
	return func(name string) string { return env[name] }
}

func mustFail(t *testing.T, changes map[string]string, want string) {
	t.Helper()
	_, err := LoadConfig(envWith(changes), testMethods)
	if err == nil {
		t.Fatalf("expected an error mentioning %q", want)
	}
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) {
		t.Fatalf("expected a ConfigError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error %q does not mention %q", err, want)
	}
}

func TestReadsAValidConfigurationAndAppliesDefaults(t *testing.T) {
	cfg, err := LoadConfig(envWith(nil), testMethods)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Network != "bsc" || cfg.Coin != "USDT" || cfg.ThresholdUSD != 10 || cfg.TopupUSD != 50 {
		t.Errorf("unexpected config: %+v", cfg)
	}
	if cfg.CheckInterval != 60 || cfg.DryRun || cfg.StateFile != "./autopay-state.json" {
		t.Errorf("defaults not applied: %+v", cfg)
	}
	if cfg.Method.Kind != "invoice" {
		t.Errorf("method kind = %q", cfg.Method.Kind)
	}
	if cfg.API != DefaultAPI {
		t.Errorf("api = %q", cfg.API)
	}
}

func TestStripsATrailingSlashFromUnalignedAPI(t *testing.T) {
	cfg, err := LoadConfig(envWith(map[string]string{"UNALIGNED_API": "https://example.test/v1/"}), testMethods)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.API != "https://example.test/v1" {
		t.Errorf("api = %q", cfg.API)
	}
}

func TestTronIsNotSupported(t *testing.T) {
	mustFail(t, map[string]string{"NETWORK": "tron"}, "Tron is not supported")
}

func TestAPairThatIsNotOfferedListsTheValidPairs(t *testing.T) {
	_, err := LoadConfig(envWith(map[string]string{"COIN": "DOGE"}), testMethods)
	if err == nil || !strings.Contains(err.Error(), "USDT/bsc") || !strings.Contains(err.Error(), "BTC/bitcoin") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTopupBelowTheMethodMinimumIsRejected(t *testing.T) {
	mustFail(t, map[string]string{"TOPUP_USD": "3"}, "TOPUP_USD")
}

func TestTopupAboveTheMethodMaximumIsRejected(t *testing.T) {
	mustFail(t, map[string]string{"TOPUP_USD": "60000", "MAX_PER_DAY_USD": "70000"}, "TOPUP_USD")
}

func TestTopupMustBeAWholeNumber(t *testing.T) {
	mustFail(t, map[string]string{"TOPUP_USD": "5.5"}, "TOPUP_USD")
}

func TestMaxPerDayMustCoverOneTopup(t *testing.T) {
	mustFail(t, map[string]string{"MAX_PER_DAY_USD": "40"}, "MAX_PER_DAY_USD")
}

func TestThresholdMustBeAboveZero(t *testing.T) {
	mustFail(t, map[string]string{"THRESHOLD_USD": "0"}, "THRESHOLD_USD")
}

func TestCheckIntervalBelow15SecondsIsRejected(t *testing.T) {
	mustFail(t, map[string]string{"CHECK_INTERVAL": "5"}, "CHECK_INTERVAL")
}

func TestAMissingWalletVariableIsNamed(t *testing.T) {
	mustFail(t, map[string]string{"EVM_PRIVATE_KEY": ""}, "EVM_PRIVATE_KEY")
}

func TestAMissingKeyIsNamed(t *testing.T) {
	mustFail(t, map[string]string{"UNALIGNED_KEY": ""}, "UNALIGNED_KEY")
}

func TestADepositMethodHasNoMaximumAndNeedsTheSolanaWallet(t *testing.T) {
	solana := map[string]string{"NETWORK": "solana", "TOPUP_USD": "1", "MAX_PER_DAY_USD": "1000000"}
	mustFail(t, solana, "SOLANA_RPC_URL")
	solana["SOLANA_RPC_URL"] = "http://x"
	solana["SOLANA_PRIVATE_KEY"] = "k"
	cfg, err := LoadConfig(envWith(solana), testMethods)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Method.Kind != "deposit" {
		t.Errorf("kind = %q", cfg.Method.Kind)
	}
}

func TestDryRunIsRead(t *testing.T) {
	cfg, err := LoadConfig(envWith(map[string]string{"DRY_RUN": "1"}), testMethods)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.DryRun {
		t.Error("DRY_RUN=1 was not read")
	}
}

func TestPreflightChecksEverythingItCanWithoutTheAPI(t *testing.T) {
	for want, changes := range map[string]map[string]string{
		"Tron":          {"NETWORK": "tron"},
		"UNALIGNED_KEY": {"UNALIGNED_KEY": ""},
		"EVM_RPC_URL":   {"EVM_RPC_URL": ""},
	} {
		if _, err := Preflight(envWith(changes)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Preflight(%v) = %v, want an error mentioning %q", changes, err, want)
		}
	}
	s, err := Preflight(envWith(nil))
	if err != nil || s.TopupUSD != 50 {
		t.Fatalf("Preflight = %+v, %v", s, err)
	}
}

func TestTokenAddressWithANativeCoinIsRejected(t *testing.T) {
	override := "0x1111111111111111111111111111111111111111"
	_, err := Preflight(envWith(map[string]string{"NETWORK": "ethereum", "COIN": "ETH", "TOKEN_ADDRESS": override}))
	if err == nil || !strings.Contains(err.Error(), "TOKEN_ADDRESS") || !strings.Contains(err.Error(), "native coin") {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := Preflight(envWith(map[string]string{"TOKEN_ADDRESS": override})); err != nil {
		t.Fatalf("a token with an override must be accepted: %v", err)
	}
}
