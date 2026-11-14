package autopay

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAMissingStateFileIsEmpty(t *testing.T) {
	state, err := NewStore(filepath.Join(t.TempDir(), "none.json")).Load()
	if err != nil || len(state.Topups) != 0 || state.Version != 1 {
		t.Fatalf("Load = %+v, %v", state, err)
	}
}

func TestSaveThenLoadRoundTripsAndLeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "state.json")
	store := NewStore(path)
	want := State{Version: 1, Topups: []Topup{record(nil)}}
	if err := store.Save(&want); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Topups) != 1 || got.Topups[0].ID != "inv-1" || got.Topups[0].Txid != nil {
		t.Errorf("round trip lost data: %+v", got)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("expected only the state file, found %d entries", len(entries))
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"txid": null`) || !strings.Contains(string(raw), `"version": 1`) {
		t.Errorf("unexpected file format:\n%s", raw)
	}
}
