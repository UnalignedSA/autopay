# Autopay in Rust

Rust 1.98.1 or newer (the Solana crates ask for it), with `tokio` and `reqwest` for the API and the wallet
RPCs, `alloy` for Ethereum and BSC, and the Solana SDK crates for Solana. It behaves exactly like the
[TypeScript reference](../typescript). See the [main README](../README.md) for what it does, every setting,
the state file and the safety notes.

```sh
cargo build --release
cp ../.env.example .env                   # then edit it
DRY_RUN=1 ./target/release/autopay once   # prints what it would send
./target/release/autopay watch            # runs until stopped (Ctrl-C or SIGTERM)
```

The program loads `.env` from the current folder if there is one. A variable already set in the
environment is never overridden by the file. The file is read by a few lines of `config.rs`, not by a
library: values are taken literally (`$NAME` is not expanded, as some `.env` libraries do), and may be
wrapped in single or double quotes. An unquoted value ends at ` #`. Wrap any value that contains `#`, `$`,
spaces or quotes in single quotes, as the main README advises for every language.

```sh
cargo test                                         # unit tests, no network
cargo clippy --all-targets -- -D warnings && cargo fmt --check
```

Layout:

| File                     | Role                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `src/main.rs`            | `once` / `watch`, signals, exit codes                         |
| `src/config.rs`          | reads and checks the environment, and `.env`                  |
| `src/api.rs`             | the Unaligned API calls                                       |
| `src/amounts.rs`         | decimal string to integer base units, exactly (`u128`)        |
| `src/state.rs`           | the state file, written atomically                            |
| `src/step.rs`            | `step()`: one check-and-top-up cycle, and the `watch` loop    |
| `src/payers/`            | the `Payer` trait and one wallet per chain family             |

Notes:

- Amounts are integers all the way: `u128` base units, turned into `U256` for EVM chains. Solana and Monero
  amounts are 64-bit; an amount that does not fit is refused, never cut short.
- For Ethereum and BSC, `transfer` is declared with no outputs, so Ethereum USDT (which returns nothing)
  works. Success is the receipt status. Fees are EIP-1559, and the chain id is read from the RPC.
- For Solana, the mint must belong to the Token or Token-2022 program and be initialized. The recipient's
  token account is created idempotently, then `TransferChecked` runs, in one transaction, on the mint's own
  program.
- Waiting for a receipt (EVM) or a confirmation (Solana) rides out RPC errors until a timeout: the
  transaction is already out at that point.
- `watch` waits between cycles with a sleep that SIGINT or SIGTERM interrupts. A signal that arrives during
  a cycle is kept, so a send that is already under way finishes, and is recorded, before the program stops.
