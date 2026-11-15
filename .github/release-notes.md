Keeps an [Unaligned](https://unaligned.pw) balance topped up, in crypto, with no one watching. See the [README](https://github.com/UnalignedSA/autopay#readme) for setup and safety.

## 2.0.0

The API's payment fields are now snake_case (`amount_usd`, `amount_crypto`, `expires_at`, `tx_hash`) with times in seconds, and `GET /payments/methods` answers `{"methods": [...]}`. Autopay 1.x no longer works against the API: upgrade.

1.x pays nothing in that state, but it does not always say so. The TypeScript and JavaScript 1.x programs stop with an error at start. The Python, Go and Rust 1.x programs log a `retry:` line and keep retrying without an error exit, so the balance silently stops being topped up.

State files are compatible: keep yours as it is, there is nothing to migrate.

## Downloads

| You want | Download |
|---|---|
| A ready-to-run program, nothing to install | `go-<os>-<arch>` or `rust-<os>-<arch>` archive for your system |
| TypeScript, already built | `typescript.zip`, then `npm ci --omit=dev && npm start -- watch` (Node 22.18+) |
| JavaScript | `node.zip`, then `npm ci --omit=dev && npm start -- watch` (Node 22.9+) |
| Python | `autopay-*.whl`: `pip install autopay-*.whl && python -m autopay watch` (Python 3.11+) |

`<os>` is `linux`, `darwin` (macOS) or `windows`; `<arch>` is `amd64` (Intel/AMD) or `arm64` (Apple Silicon, ARM). Rust builds cover linux-amd64, macOS (both) and windows-amd64; Go covers all six.

Each archive holds the program, `README.md`, `LICENSE` and `.env.example`. Copy `.env.example` to `.env` next to the program and fill it in.

## Verify your download

This program holds a wallet's private key: check what you run.

```sh
sha256sum -c SHA256SUMS --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing  # macOS
```

The binaries are not code-signed. On macOS, the first launch needs right-click then Open (or `xattr -d com.apple.quarantine ./autopay`); on Windows, SmartScreen asks to confirm.

## Before the first real run

Use a dedicated wallet with a few top-ups' worth on it, set `MAX_PER_DAY_USD`, and try `DRY_RUN=1 ./autopay once` first.
