# unaligned-autopay

Keeps an [Unaligned](https://unaligned.pw) balance topped up, in crypto, with no one watching.

A small program checks your balance. When it drops below a threshold, it asks the
[Payments API](https://unaligned.pw/docs/payments) for an invoice, pays it from a wallet you control,
and follows it until it is credited. The same program is provided in five languages, each in its own
folder, with the same configuration, the same behaviour and the same state file (only the way each reads
a `.env` file differs, see [Configuration](#configuration)):

| Folder | Language | Run |
|---|---|---|
| [`typescript/`](typescript) | TypeScript (reference), Node 22.18+ | `npm install && npm run build && npm start -- watch` |
| [`node/`](node) | JavaScript, Node 22.9+ | `npm install && npm start -- watch` |
| [`python/`](python) | Python 3.11+ | `pip install -e . && python -m autopay watch` |
| [`go/`](go) | Go 1.25+ | `go build -o autopay ./cmd/autopay && ./autopay watch` |
| [`rust/`](rust) | Rust 1.98.1+ | `cargo build --release && ./target/release/autopay watch` |

Read one, run one, or copy the parts you need into your own code.

## How it works

Once per `CHECK_INTERVAL`:

1. Read open top-ups from the state file. If a payment is in flight, follow it and do nothing else.
2. `GET /balance`. If it is at least `THRESHOLD_USD`, stop.
3. If sending `TOPUP_USD` would go over `MAX_PER_DAY_USD` in 24 hours, stop.
4. `POST /payments` for `TOPUP_USD` in your coin and network. Methods of kind `deposit` (USDT and USDC
   on Solana) answer with your fixed deposit address instead of an invoice, credited 1:1.
5. Write `sending` to the state file, send the exact `amountCrypto` to `address`, write `sent`.
6. Poll `GET /payments/{id}` (or the deposit list) until it is `paid` (or `credited`).

Crypto amounts are never floats: they stay decimal strings and become integer base units with exact
integer arithmetic.

## Configuration

Environment variables, see [`.env.example`](.env.example). The programs read the real environment;
from inside a language folder, copy `.env.example` to `.env` there: every program loads a `.env` file from its
folder (or the current folder) if there is one, and a variable already set in the environment is never
overridden by the file. Each language's README has the details.

**Quote values in `.env`.** Wrap any value that contains `#`, `$`, spaces or quotes in single quotes:
`WALLET_RPC_PASSWORD='p#ss $word'`. The five programs read `.env` with different readers, and they do not
agree on unquoted values (Node cuts the value at `#`, Go's reader expands `$NAME`), but all five take a
single-quoted value literally. Such a value cannot itself contain a single quote. Variables set in the real
environment are never parsed, so they need no quoting.

| Variable | Default | Notes |
|---|---|---|
| `UNALIGNED_KEY` | required | API key of the account to top up |
| `UNALIGNED_API` | `https://api.unaligned.pw/v1` | no trailing slash |
| `NETWORK`, `COIN` | required | must be a pair of `GET /payments/methods`. Tron is not supported yet |
| `THRESHOLD_USD` | required | number, > 0 |
| `TOPUP_USD` | required | integer, from the method's `min_usd` to its `max_usd` |
| `MAX_PER_DAY_USD` | required | integer, at least `TOPUP_USD` |
| `CHECK_INTERVAL` | `60` | seconds, minimum 15 |
| `DRY_RUN` | `0` | `1`: create the payment, print it, send nothing, write no state |
| `REFUND_ADDRESS` | the wallet's address (EVM, Solana), none otherwise | where an incomplete payment goes back to |
| `STATE_FILE` | `./autopay-state.json` | |
| `TOKEN_ADDRESS` | built in (see below) | the contract or mint of `COIN` itself. Leave it unset on mainnet |
| `EVM_RPC_URL`, `EVM_PRIVATE_KEY` | | `ethereum`, `bsc` |
| `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY` | | base58 secret key, or the JSON byte array of a `solana-keygen` file |
| `WALLET_RPC_URL`, `WALLET_RPC_USER`, `WALLET_RPC_PASSWORD` | | `bitcoin`, `litecoin`: a node wallet's RPC; the URL may include `/wallet/<name>` |
| `MONERO_WALLET_RPC_URL`, `MONERO_WALLET_RPC_USER`, `MONERO_WALLET_RPC_PASSWORD` | | `monero`: user and password optional (digest auth) |

Built-in tokens (mainnet):

| | USDT | USDC |
|---|---|---|
| Ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| BSC | `0x55d398326f99059fF775485246999027B3197955` | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| Solana | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Token decimals are always read on chain. Native decimals: ETH 18, SOL 9, BTC 8, LTC 8, XMR 12.

## Usage

```sh
autopay once    # one check, then exit (cron, systemd timer)
autopay watch   # check every CHECK_INTERVAL until stopped
```

Exit codes: `0` ok, `1` fatal (configuration, bad key, corrupt state file, rejected request),
`3` manual check needed (see below). Run the Go program as a built binary: `go run` reports any failure of
the program as exit `1`, so a manual check (`3`) would look like a fatal error.

Under cron or systemd, set `STATE_FILE` to an absolute path and start the program from the folder that
holds `.env`: both are found relative to the working directory, and a scheduler starts in a folder of its
own (cron in your home folder, systemd in `/`). Run only one copy per state file (see [Safety](#safety)).

`watch` keeps going through temporary failures (network errors, 5xx): it logs `retry: ...` and tries
again on the next tick. It exits on a fatal error or when a manual check is needed.

Log lines, one per event, each prefixed by an ISO timestamp:

```
balance 42.5 >= threshold 10
created invoice 6f1c2e0a-...: send 50.00 USDT on bsc to 0x8c82...a4ac
sent 0xabc...
waiting 6f1c2e0a-... (confirming)
done 6f1c2e0a-... (paid)
daily cap reached (95/100 USD in 24h)
MANUAL CHECK: <reason>
retry: <reason>
```

## State file

`autopay-state.json` records every top-up so a restart never pays twice. It is written atomically
(temp file, fsync, rename) before every send:

```json
{ "version": 1, "topups": [ {
  "id": "6f1c2e0a-3b7d-4c55-9a51-2f0f6b8e4d21", "kind": "invoice",
  "network": "bsc", "coin": "USDT", "amountUsd": 50, "amountCrypto": "50.00", "address": "0x...",
  "expiresAt": 1793926800000, "phase": "created", "txid": null,
  "createdAt": 1793925000000, "sentAt": null, "result": null } ] }
```

`phase` goes `created`, `sending`, `sent`, `done`. For a deposit, `id` is `deposit:pending` until the
transaction id is known, then `deposit:<txid>`. `result` is the final status: `paid`, `expired`,
`refunded` or `credited`.

If the file cannot be read or parsed, the program refuses to start (exit 1). It never treats it as
empty: that would forget a payment in flight and could pay twice.

## Safety

This program moves real money without asking. Treat it like that.

- **Use a dedicated wallet** that holds little more than a few top-ups. Never point it at your main
  wallet. The private key sits in an environment variable.
- **`MAX_PER_DAY_USD` is your ceiling.** Whatever goes wrong (a bug, a loop, a repeated failure), the
  program will not send more than this in 24 hours. It counts what the state file records, so this holds
  as long as the state file is kept and only one copy of the program runs on it.
- **Run one copy per state file.** Two copies on the same file do not see each other's payment in flight:
  each can create and pay its own invoice, and each counts the daily cap on its own. Under cron, wrap the
  program in `flock` so that a run never starts while the previous one is still going:

  ```
  */5 * * * * cd /srv/autopay/go && flock -n /srv/autopay/state.json.lock ./autopay once
  ```

  `flock -n` skips the run when the lock is taken, instead of queueing it. A systemd service or timer
  already runs a single instance.
- **Start with `DRY_RUN=1`, with `once`.** It creates a payment (an unpaid invoice just expires), prints
  what it would send, and sends nothing. Each dry run leaves an open invoice for 30 minutes and the API
  allows 3 open at a time, so a dry run under `watch` is soon refused.
- **A payment close to expiry is not sent.** After a restart, an invoice with less than 5 minutes left
  is left to expire, and a new one is made later.
- **Reseller customer keys get 403.** A customer key of a reseller cannot top up (the money would go to
  the reseller), so the program stops with a clear message. Use the account's own key.

### MANUAL CHECK

The program exits with code 3 and prints `MANUAL CHECK: <reason>` when it cannot know whether money
moved. It will not guess. Three cases:

- **A send may or may not have gone out** (the state shows `sending`): the program crashed, or the
  wallet call failed, in the middle of a send. Look at your wallet's history.
  - The payment is there: set the record's `phase` to `sent`, `txid` to the transaction id and `sentAt`
    to the time it went out (milliseconds since 1970). `sentAt` matters: it is what the daily cap counts.
  - It is not: set `phase` to `done` and `result` to `"failed"`.
- **An invoice expired after you paid it** (the state shows `sent`, the API says `expired`): a late
  payment is still credited. Check your balance and the wallet, then set the record's `phase` to `done`.
- **A deposit is not credited 2 hours after the send** (the state shows `sent` for a `deposit` record):
  look the transaction up on chain and check your balance, then set the record's `phase` to `done` (and
  `result` to `"failed"` if the transaction never landed).

Edit the file while the program is stopped, then start it again.

## Behaviour details

These choices are the same in every language. Only the `.env` readers differ (see
[Configuration](#configuration)).

- **Order of checks at start**: the environment is validated first (required variables, Tron, numbers,
  `CHECK_INTERVAL`, the wallet variables of the network). Only then is `GET /payments/methods` called
  (public, sent without your key) to check the coin, network and amount.
- **Retries**: network errors, timeouts, unreadable responses, HTTP 5xx and HTTP 429 are temporary.
  `watch` logs `retry: ...` and tries again on the next tick, including when the API is down at start;
  `once` logs it and exits `0`. HTTP 401 and 403 and any other 4xx are fatal (`1`).
- **Daily cap**: a top-up is refused when `TOPUP_USD` plus what was sent in the last 24 hours is above
  `MAX_PER_DAY_USD`. The log shows what was already sent: `daily cap reached (45/50 USD in 24h)`. A
  record counts from `sentAt`; a hand-edited record without it (it has a `txid`, or is `sending` or
  `sent`) counts from `createdAt`.
- **The payment must match the request**: before anything is sent, the coin and network of the answer
  must be the configured ones and an invoice's `amountUsd` must equal `TOPUP_USD`. Otherwise the
  program stops with exit `1`, sends nothing and records nothing.
- **A resumed invoice must match too**: an invoice that was created but not sent (the program stopped in
  between) is only paid if its coin and network are still the configured ones. If you changed `NETWORK`
  or `COIN` meanwhile, the program stops with exit `1`: set them back until the invoice is done, or close
  the record in the state file.
- **EVM chain id**: at start, the program reads the chain id of `EVM_RPC_URL` and stops with exit `1` if
  it is the other mainnet (chain id 1 with `NETWORK=bsc`, 56 with `NETWORK=ethereum`). It checks again
  before signing. Other chain ids are allowed, so test chains work. If the node does not answer at start,
  it is a temporary failure, like the API being down.
- **Invoice not `waiting`**: a `created` invoice (not yet sent) whose status is already something else
  than `waiting` and `expired` (for example `confirming`) is never paid again: the cycle ends `Pending`.
  `paid` and `refunded` close it, `expired` closes it as `expired`.
- **Deposits are given 2 hours**: a deposit record in `sent` that the deposit list still does not show as
  credited 2 hours after `sentAt` (or `createdAt` for a hand-edited record) stops the program with
  `MANUAL CHECK` (exit `3`). A transaction that is not listed by then was most likely dropped, and waiting
  longer would not tell.
- **The transaction id is never lost**: `sent <txid>` is logged before the state file is written, so it
  is on screen even if that write fails.
- **State file validation**: every field of every record is checked. A malformed record is fatal, so
  check your edits.
- **Dry run**: `DRY_RUN=1` still needs the wallet variables (the default refund address is the wallet's).

## Not included

Tron, hardware wallets, and anything that needs a human to approve. Pull requests are welcome.

## License

MIT
