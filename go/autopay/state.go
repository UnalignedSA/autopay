package autopay

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
)

// Topup is one top-up, from the payment being asked for to the account being credited.
type Topup struct {
	// ID is the invoice id, or "deposit:<txid>" for a deposit ("deposit:pending" until the txid is known).
	ID           string  `json:"id"`
	Kind         string  `json:"kind"` // invoice or deposit
	Network      string  `json:"network"`
	Coin         string  `json:"coin"`
	AmountUSD    float64 `json:"amountUsd"`
	AmountCrypto string  `json:"amountCrypto"`
	Address      string  `json:"address"`
	// ExpiresAt is in milliseconds since 1970. Nil for a deposit address, which never expires.
	ExpiresAt *int64 `json:"expiresAt"`
	// Phase is created, sending, sent or done.
	Phase     string  `json:"phase"`
	Txid      *string `json:"txid"`
	CreatedAt int64   `json:"createdAt"`
	SentAt    *int64  `json:"sentAt"`
	// Result is the final status: paid, expired, refunded or credited.
	Result *string `json:"result"`
}

// State is the whole state file.
type State struct {
	Version int     `json:"version"`
	Topups  []Topup `json:"topups"`
}

// StateError means the state file cannot be trusted. It is fatal: guessing could pay twice.
type StateError struct{ Message string }

func (e *StateError) Error() string { return e.Message }

// Store reads and writes the state file.
type Store struct{ path string }

// NewStore returns a store for the file at path.
func NewStore(path string) *Store { return &Store{path: path} }

// Load reads the file. A missing file is an empty state; anything else that is not a valid state is an error.
func (s *Store) Load() (*State, error) {
	text, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return &State{Version: 1, Topups: []Topup{}}, nil
	}
	if err != nil {
		return nil, &StateError{fmt.Sprintf("cannot read state file %s: %v", s.path, err)}
	}
	var raw any
	if err := json.Unmarshal(text, &raw); err != nil {
		return nil, &StateError{fmt.Sprintf("state file %s is not valid JSON; fix or remove it by hand", s.path)}
	}
	state, ok := parseState(raw)
	if !ok {
		return nil, &StateError{fmt.Sprintf("state file %s has an unknown format; fix or remove it by hand", s.path)}
	}
	return state, nil
}

// Save writes to a temporary file, fsyncs it, then renames it over the real one.
func (s *Store) Save(state *State) error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')

	tmp := s.path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	// Make the rename itself durable. Not possible on every platform (Windows): best effort.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// parseState checks every field of every record, because the file is meant to be hand-edited.
func parseState(raw any) (*State, bool) {
	root, ok := raw.(map[string]any)
	if !ok || root["version"] != float64(1) {
		return nil, false
	}
	list, ok := root["topups"].([]any)
	if !ok {
		return nil, false
	}
	state := &State{Version: 1, Topups: make([]Topup, 0, len(list))}
	for _, item := range list {
		fields, ok := item.(map[string]any)
		if !ok {
			return nil, false
		}
		topup, ok := parseTopup(fields)
		if !ok {
			return nil, false
		}
		state.Topups = append(state.Topups, topup)
	}
	return state, true
}

func parseTopup(f map[string]any) (t Topup, ok bool) {
	var good = [...]bool{
		str(f, "id", &t.ID),
		oneOf(f, "kind", &t.Kind, "invoice", "deposit"),
		str(f, "network", &t.Network),
		str(f, "coin", &t.Coin),
		num(f, "amountUsd", &t.AmountUSD),
		str(f, "amountCrypto", &t.AmountCrypto),
		str(f, "address", &t.Address),
		optInt(f, "expiresAt", &t.ExpiresAt),
		oneOf(f, "phase", &t.Phase, "created", "sending", "sent", "done"),
		optStr(f, "txid", &t.Txid),
		reqInt(f, "createdAt", &t.CreatedAt),
		optInt(f, "sentAt", &t.SentAt),
		optStr(f, "result", &t.Result),
	}
	for _, g := range good {
		if !g {
			return Topup{}, false
		}
	}
	return t, true
}

func str(f map[string]any, key string, out *string) bool {
	v, ok := f[key].(string)
	*out = v
	return ok
}

func oneOf(f map[string]any, key string, out *string, allowed ...string) bool {
	if !str(f, key, out) {
		return false
	}
	for _, a := range allowed {
		if *out == a {
			return true
		}
	}
	return false
}

func num(f map[string]any, key string, out *float64) bool {
	v, ok := f[key].(float64)
	*out = v
	return ok && !math.IsInf(v, 0) && !math.IsNaN(v)
}

// A timestamp is a whole number of milliseconds.
func reqInt(f map[string]any, key string, out *int64) bool {
	var v float64
	if !num(f, key, &v) || v != math.Trunc(v) || math.Abs(v) > 1<<53 {
		return false
	}
	*out = int64(v)
	return true
}

func optInt(f map[string]any, key string, out **int64) bool {
	if v, present := f[key]; present && v == nil {
		*out = nil
		return true
	}
	var v int64
	if !reqInt(f, key, &v) {
		return false
	}
	*out = &v
	return true
}

func optStr(f map[string]any, key string, out **string) bool {
	if v, present := f[key]; present && v == nil {
		*out = nil
		return true
	}
	var v string
	if !str(f, key, &v) {
		return false
	}
	*out = &v
	return true
}
