# Autopay in Python

Typed Python (3.11 or newer) with `httpx` for the API and the wallet RPCs, `web3` for Ethereum and BSC,
and `solana` with `solders` for Solana. It behaves exactly like the [TypeScript reference](../typescript).
See the [main README](../README.md) for what it does, every setting, the state file and the safety notes.

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
cp ../.env.example .env                      # then edit it
DRY_RUN=1 python -m autopay once             # prints what it would send
python -m autopay watch                      # runs until stopped
```

The program loads `.env` from the current folder if there is one. A variable already set in the
environment is never overridden by the file. The file is read by a few lines of `__main__.py`: `$NAME` is
not expanded, and an unquoted value ends at ` #`. Wrap any value that contains `#`, `$`, spaces or quotes
in single quotes; it is then taken literally.

```sh
pytest                                       # unit tests, no network
ruff check && ruff format --check            # lint and format
```

Layout:

| File                      | Role                                                   |
| ------------------------- | ------------------------------------------------------ |
| `autopay/config.py`       | reads and checks the environment                       |
| `autopay/api.py`          | the Unaligned API calls                                |
| `autopay/amounts.py`      | decimal string to integer base units, exactly          |
| `autopay/state.py`        | the state file, written atomically                     |
| `autopay/core.py`         | `step()`: one check-and-top-up cycle, and `watch_loop` |
| `autopay/payers/`         | one wallet per chain family                            |
| `autopay/__main__.py`     | `once` / `watch`, exit codes                           |
