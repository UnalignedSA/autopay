"""Command line: `python -m autopay once` or `python -m autopay watch`."""

import os
import signal
import sys
import threading
import time
import traceback
from dataclasses import dataclass, replace

from .api import Api, ApiError
from .config import Config, ConfigError, api_base, load_config, preflight
from .core import EXIT_FATAL, EXIT_MANUAL_CHECK, Fatal, Outcome, Payer, Status, eprint, log, step, watch_loop
from .payers import make_payer
from .state import StateStore


@dataclass
class Session:
    cfg: Config
    api: Api
    payer: Payer
    store: StateStore


def set_up(env: dict[str, str] | os._Environ[str]) -> Session:
    """Checks the environment, then asks the API for the payment methods.

    Nothing leaves the machine before the checks pass.
    """
    preflight(env)
    methods = Api(api_base(env), "").methods()
    cfg = load_config(env, methods)
    api = Api(cfg.api, cfg.key)
    payer = make_payer(cfg, env)
    # An incomplete payment goes back to the wallet itself unless told otherwise.
    if not cfg.refund_address and cfg.network in ("ethereum", "bsc", "solana"):
        cfg = replace(cfg, refund_address=payer.address())
    return Session(cfg, api, payer, StateStore(cfg.state_file))


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else None
    if mode not in ("once", "watch"):
        eprint("usage: python -m autopay once | python -m autopay watch")
        return EXIT_FATAL

    session: Session | None = None

    def cycle() -> Outcome:
        """Set-up counts as part of a cycle: if the API is down at start, `watch` tries again on the next tick."""
        nonlocal session
        if session is None:
            try:
                session = set_up(os.environ)
            except ApiError as err:
                if not err.transient:
                    raise
                log(f"retry: {err}")
                return Outcome(Status.RETRY, str(err))
        return step(session.cfg, session.api, session.payer, session.store, lambda: time.time_ns() // 1_000_000)

    try:
        if mode == "once":
            return EXIT_MANUAL_CHECK if cycle().status is Status.MANUAL_CHECK else 0

        stopping = threading.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: stopping.set())
        # Event.wait is the sleep: it wakes at once on a signal, and keeps the process alive meanwhile.
        return watch_loop(
            cycle,
            stopping.wait,
            lambda: session.cfg.check_interval if session else 60,
            stopping.is_set,
        )
    except (Fatal, ConfigError, ApiError) as err:
        eprint(f"error: {err}")
        return EXIT_FATAL
    except Exception:
        traceback.print_exc()
        return EXIT_FATAL


if __name__ == "__main__":
    sys.exit(main(sys.argv))
