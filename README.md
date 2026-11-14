# unaligned-autopay

Keeps an [Unaligned](https://unaligned.pw) balance topped up, in crypto, with no one watching.

A small program checks your balance. When it drops below a threshold, it asks the
[Payments API](https://unaligned.pw/docs/payments) for an invoice, pays it from a wallet you control,
and follows it until it is credited. The same program is provided in five languages, each in its own
folder, with the same configuration, the same behaviour and the same state file:

| Folder | Language |
|---|---|
| [`typescript/`](typescript) | TypeScript (reference) |
| `javascript/` | JavaScript |
| `python/` | Python |
| `go/` | Go |
| `rust/` | Rust |

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
each language's README says how to load a `.env` file.

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
| `TOKEN_ADDRESS` | built in (see below) | USDT/USDC contract or mint |
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
`3` manual check needed (see below).

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
- **`MAX_PER_DAY_USD` is your ceiling.** Whatever goes wrong (a bug, a loop, a repeated failure), the program will not send more than this in 24 hours.
- **Start with `DRY_RUN=1`.** It creates a payment (an unpaid invoice just expires), prints what it
  would send, and sends nothing.
- **A payment close to expiry is not sent.** After a restart, an invoice with less than 5 minutes left
  is left to expire, and a new one is made later.
- **Reseller customer keys get 403.** A customer key of a reseller cannot top up (the money would go to
  the reseller), so the program stops with a clear message. Use the account's own key.

### MANUAL CHECK

The program exits with code 3 and prints `MANUAL CHECK: <reason>` when it cannot know whether money
moved. It will not guess. Two cases:

- **A send may or may not have gone out** (the state shows `sending`): the program crashed, or the
  wallet call failed, in the middle of a send. Look at your wallet's history.
  - The payment is there: set the record's `phase` to `sent` and its `txid` to the transaction id.
  - It is not: set `phase` to `done` and `result` to `"failed"`.
- **An invoice expired after you paid it** (the state shows `sent`, the API says `expired`): a late
  payment is still credited. Check your balance and the wallet, then set the record's `phase` to `done`.

Edit the file while the program is stopped, then start it again.

## Not included

Tron, hardware wallets, and anything that needs a human to approve. Pull requests are welcome.

## License

MIT
