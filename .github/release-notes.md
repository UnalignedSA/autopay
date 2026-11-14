Keeps an [Unaligned](https://unaligned.pw) balance topped up, in crypto, with no one watching. See the [README](https://github.com/UnalignedSA/autopay#readme) for setup and safety.

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
