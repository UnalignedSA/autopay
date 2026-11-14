package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/joho/godotenv"
)

// The README asks for single quotes around a value with `#`, `$`, spaces or quotes: godotenv must take it as is.
func TestASingleQuotedEnvValueIsTakenLiterally(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	text := "QUOTED='p#ss $HOME \"q\" x'\nBARE=p$HOME\n"
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := godotenv.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := values["QUOTED"], `p#ss $HOME "q" x`; got != want {
		t.Errorf("QUOTED = %q, want %q", got, want)
	}
	// Unquoted, `$HOME` is expanded (from the variables set earlier in the file, none here) and vanishes: hence
	// the advice to quote.
	if got, want := values["BARE"], "p"; got != want {
		t.Errorf("BARE = %q, want %q", got, want)
	}
}
