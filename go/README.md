# Autopay in Go

Go 1.25 or newer, with the standard `net/http` for the API and the wallet RPCs, `go-ethereum` for
Ethereum and BSC, and `solana-go` for Solana. It behaves exactly like the [TypeScript reference](../typescript).
See the [main README](../README.md) for what it does, every setting, the state file and the safety notes.

```sh
go build -o autopay ./cmd/autopay
cp ../.env.example .env                      # then edit it
DRY_RUN=1 ./autopay once                     # prints what it would send
./autopay watch                              # runs until stopped (Ctrl-C or SIGTERM)
```

Run the built binary, not `go run`: `go run` turns any failure of the program into exit code `1`, so a
manual check (exit `3`) would look like a fatal error.

The program loads `.env` from the current folder if there is one (with
[godotenv](https://github.com/joho/godotenv)). A variable already set in the environment is never
overridden by the file. godotenv expands `$NAME` in unquoted and double-quoted values: wrap any value that
contains `#`, `$`, spaces or quotes in single quotes, which godotenv takes literally.

```sh
go test ./...                                # unit tests, no network
go vet ./... && gofmt -l .                   # lint and format (no output means clean)
```

Layout:

| File                       | Role                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `cmd/autopay/main.go`      | `once` / `watch`, signals, exit codes                           |
| `autopay/config.go`        | reads and checks the environment                                |
| `autopay/api.go`           | the Unaligned API calls                                         |
| `autopay/amounts.go`       | decimal string to integer base units, exactly (`math/big`)      |
| `autopay/state.go`         | the state file, written atomically                              |
| `autopay/step.go`          | `Step()`: one check-and-top-up cycle, the `Payer` interface, `WatchLoop` |
| `autopay/payers/`          | one wallet per chain family                                     |

Notes:

- The `Payer` interface lives in `autopay` (next to `Step`, which uses it); `autopay/payers` implements it.
- For Solana, the recipient's token account is created with the library's idempotent instruction. The
  `TransferChecked` instruction is built by hand (twelve lines) so that it works with Token-2022 mints
  as well; the library's one is fixed to the classic token program.
- `watch` waits between cycles with a sleep that a signal interrupts. A send that is already under way
  is never cancelled by the signal: it finishes, and is recorded, before the program stops.
