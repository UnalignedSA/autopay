"""`step()`: one check-and-maybe-top-up cycle, and the `watch` loop around it."""

import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Protocol

from .api import ApiError, Deposit, Invoice, Kind
from .config import Config
from .state import Phase, StateError, StateStore, Topup

MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR
#: An invoice with less time left than this is not paid: the payment could land after it expires.
MIN_TIME_LEFT = 5 * MINUTE
#: A deposit not credited this long after the send needs a person to look at it.
DEPOSIT_CREDIT_WAIT = 2 * HOUR

EXIT_FATAL = 1
EXIT_MANUAL_CHECK = 3


class ApiLike(Protocol):
    """The part of the API that `step` uses. `Api` implements it; tests use a fake."""

    def balance(self) -> float: ...
    def create_payment(self, body: dict[str, object]) -> Invoice | Deposit: ...
    def get_payment(self, payment_id: str) -> Invoice: ...
    def deposit(self, network: str) -> Deposit: ...


class Payer(Protocol):
    """Sends crypto from the wallet. One implementation per chain family, each a subclass of this one."""

    def address(self) -> str:
        """The wallet's own address."""
        ...

    def send(self, to: str, coin: str, amount_crypto: str) -> str:
        """Sends `amount_crypto` (a decimal string) of `coin` to `to`. Returns the transaction id."""
        ...

    def check(self) -> None:
        """Checks the wallet's node once, before any payment is created.

        Raises ConfigError when the node can never be right (an EVM node of the other mainnet). Wallets with
        nothing to check keep this default, which does nothing.
        """
        return None


class Status(Enum):
    IDLE = "idle"
    PENDING = "pending"
    SENT = "sent"
    DAILY_CAP = "daily cap"
    MANUAL_CHECK = "manual check"
    RETRY = "retry"


@dataclass(frozen=True)
class Outcome:
    """What one cycle did. `reason` is set for MANUAL_CHECK and RETRY."""

    status: Status
    reason: str = ""


class Fatal(Exception):
    """Something that will not fix itself: bad configuration, bad key, corrupt state, rejected request."""


Log = Callable[[str], None]
Clock = Callable[[], int]


def log(message: str) -> None:
    stamp = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    print(f"{stamp} {message}", flush=True)


def fmt(value: float) -> str:
    """A number as a person writes it: 10, not 10.0."""
    return str(int(value)) if float(value).is_integer() else str(value)


def step(cfg: Config, api: ApiLike, payer: Payer, store: StateStore, now: Clock, out: Log = log) -> Outcome:
    """One check-and-maybe-top-up cycle."""
    try:
        return _cycle(cfg, api, payer, store, now, out)
    except StateError as err:
        raise Fatal(str(err)) from err
    except ApiError as err:
        if err.transient:
            out(f"retry: {err}")
            return Outcome(Status.RETRY, str(err))
        if err.status == 401:
            raise Fatal("the API key was rejected (401)") from err
        if err.status == 403:
            raise Fatal(
                "this key cannot top up (403): a reseller's customer key can't, use the account's own key"
            ) from err
        raise Fatal(str(err)) from err


def _cycle(cfg: Config, api: ApiLike, payer: Payer, store: StateStore, now: Clock, out: Log) -> Outcome:
    topups = store.load()
    open_topup = next((t for t in topups if t.phase is not Phase.DONE), None)

    if open_topup is not None and open_topup.phase is Phase.SENDING:
        return _manual_check(out, "a send may or may not have gone out: check the wallet, then edit the state file")
    if open_topup is not None and open_topup.phase is Phase.SENT:
        return _follow(api, topups, store, open_topup, now, out)

    if open_topup is not None:
        # Created but not sent: the program stopped between the two. Never pay it with another wallet.
        if open_topup.network != cfg.network or open_topup.coin != cfg.coin:
            raise Fatal(
                f"invoice {open_topup.id} waits for {open_topup.coin} on {open_topup.network}, but the configuration "
                f"says {cfg.coin} on {cfg.network}: set them back until it is done, or close it in the state file"
            )
        invoice = api.get_payment(open_topup.id)
        if invoice.status in ("expired", "paid", "refunded"):
            _finish(topups, store, open_topup, invoice.status, out)
            return Outcome(Status.IDLE)
        time_left = (open_topup.expires_at - now()) if open_topup.expires_at is not None else float("inf")
        if invoice.status != "waiting" or time_left < MIN_TIME_LEFT:
            out(f"waiting {open_topup.id} ({invoice.status})")
            return Outcome(Status.PENDING)
        topup = open_topup
    else:
        balance = api.balance()
        if balance >= cfg.threshold_usd:
            out(f"balance {fmt(balance)} >= threshold {fmt(cfg.threshold_usd)}")
            return Outcome(Status.IDLE)

        since = now() - DAY
        sent_today = sum(t.amount_usd for t in topups if (at := _send_time(t)) is not None and at > since)
        if sent_today + cfg.topup_usd > cfg.max_per_day_usd:
            out(f"daily cap reached ({fmt(sent_today)}/{cfg.max_per_day_usd} USD in 24h)")
            return Outcome(Status.DAILY_CAP)

        topup = _create_topup(cfg, api, now())
        if cfg.dry_run:
            out(f"would send {topup.amount_crypto} {topup.coin} on {topup.network} to {topup.address}")
            return Outcome(Status.IDLE)
        topups.append(topup)
        # A deposit has nothing to wait for: it goes straight to `sending`.
        if topup.kind is Kind.INVOICE:
            store.save(topups)

    out(
        f"created {topup.kind} {topup.id}: "
        f"send {topup.amount_crypto} {topup.coin} on {topup.network} to {topup.address}"
    )
    return _send(payer, topups, store, topup, now, out)


def _send_time(t: Topup) -> int | None:
    """When money went out for this record, or None if it did not.

    A record edited by hand after a manual check may lack `sent_at`: it still counts, dated by its
    creation, so the daily cap cannot be bypassed.
    """
    if t.sent_at is not None:
        return t.sent_at
    sent = t.txid is not None or t.phase in (Phase.SENDING, Phase.SENT)
    return t.created_at if sent else None


def _create_topup(cfg: Config, api: ApiLike, now: int) -> Topup:
    """Asks the API for a payment and turns the answer into a state record (not saved yet)."""
    if cfg.method.kind is Kind.DEPOSIT:
        deposit = api.create_payment({"coin": cfg.coin, "network": cfg.network})
        if not isinstance(deposit, Deposit):
            raise Fatal("the API answered with an invoice, not a deposit address")
        if deposit.network != cfg.network or cfg.coin not in deposit.coins:
            raise Fatal(
                f"the API answered with {'/'.join(deposit.coins)} on {deposit.network}, not {cfg.coin} on {cfg.network}"
            )
        # A fixed deposit address is credited 1:1, so the dollars are the amount.
        return Topup(
            id="deposit:pending",
            kind=Kind.DEPOSIT,
            network=cfg.network,
            coin=cfg.coin,
            amount_usd=cfg.topup_usd,
            amount_crypto=str(cfg.topup_usd),
            address=deposit.address,
            expires_at=None,
            phase=Phase.SENDING,
            txid=None,
            created_at=now,
            sent_at=None,
            result=None,
        )

    body: dict[str, object] = {"amount_usd": cfg.topup_usd, "coin": cfg.coin, "network": cfg.network}
    if cfg.refund_address:
        body["refund_address"] = cfg.refund_address
    invoice = api.create_payment(body)
    if not isinstance(invoice, Invoice):
        raise Fatal("the API answered with a deposit address, not an invoice")
    # Never pay something that is not what was asked for.
    if invoice.coin != cfg.coin or invoice.network != cfg.network or invoice.amount_usd != cfg.topup_usd:
        raise Fatal(
            f"the API answered with {invoice.amount_usd} USD in {invoice.coin} on {invoice.network}, "
            f"not {cfg.topup_usd} USD in {cfg.coin} on {cfg.network}"
        )
    return Topup(
        id=invoice.id,
        kind=Kind.INVOICE,
        network=cfg.network,
        coin=cfg.coin,
        amount_usd=cfg.topup_usd,
        amount_crypto=invoice.amount_crypto,
        address=invoice.address,
        expires_at=invoice.expires_at,
        phase=Phase.CREATED,
        txid=None,
        created_at=now,
        sent_at=None,
        result=None,
    )


def _send(payer: Payer, topups: list[Topup], store: StateStore, topup: Topup, now: Clock, out: Log) -> Outcome:
    """The one place money leaves the wallet. `sending` is on disk before the payer is called."""
    topup.phase = Phase.SENDING
    store.save(topups)

    try:
        txid = payer.send(topup.address, topup.coin, topup.amount_crypto)
    except Exception as err:
        # The record stays `sending`: we cannot know whether the transaction went out.
        return _manual_check(
            out, f"the send failed ({err}) but may have gone out: check the wallet, then edit the state file"
        )

    # Logged before the save: if the save fails, the transaction id is still on screen.
    out(f"sent {txid}")
    topup.phase = Phase.SENT
    topup.txid = txid
    topup.sent_at = now()
    if topup.kind is Kind.DEPOSIT:
        topup.id = f"deposit:{txid}"
    store.save(topups)
    return Outcome(Status.SENT)


def _follow(api: ApiLike, topups: list[Topup], store: StateStore, topup: Topup, now: Clock, out: Log) -> Outcome:
    """Follows a payment that was sent until the account is credited."""
    if topup.kind is Kind.DEPOSIT:
        deposits = api.deposit(topup.network).deposits
        if any(d.tx_hash == topup.txid and d.credited for d in deposits):
            _finish(topups, store, topup, "credited", out)
            return Outcome(Status.IDLE)
        # A deposit is listed once its transaction is seen on chain. One still missing after hours was most
        # likely dropped, or went somewhere else: waiting longer will not tell.
        sent_at = topup.sent_at if topup.sent_at is not None else topup.created_at
        if now() - sent_at > DEPOSIT_CREDIT_WAIT:
            return _manual_check(
                out,
                f"deposit {topup.txid} is not credited 2 hours after the send: look the transaction up on chain, "
                "then edit the state file",
            )
        out(f"waiting {topup.id} (not credited yet)")
        return Outcome(Status.PENDING)

    invoice = api.get_payment(topup.id)
    if invoice.status in ("paid", "refunded"):
        _finish(topups, store, topup, invoice.status, out)
        return Outcome(Status.IDLE)
    if invoice.status == "expired":
        # A payment that arrives after the invoice expired is still credited, so this may be fine.
        return _manual_check(
            out,
            f"invoice {topup.id} expired after the send: check your balance and the wallet, then edit the state file",
        )
    out(f"waiting {topup.id} ({invoice.status})")
    return Outcome(Status.PENDING)


def _finish(topups: list[Topup], store: StateStore, topup: Topup, result: str, out: Log) -> None:
    topup.phase = Phase.DONE
    topup.result = result
    store.save(topups)
    out(f"done {topup.id} ({result})")


def _manual_check(out: Log, reason: str) -> Outcome:
    out(f"MANUAL CHECK: {reason}")
    return Outcome(Status.MANUAL_CHECK, reason)


def watch_loop(
    run: Callable[[], Outcome],
    sleep: Callable[[float], None],
    interval_seconds: Callable[[], float],
    stopped: Callable[[], bool],
) -> int:
    """Runs `run` every `interval_seconds()` until it asks for a manual check (exit 3) or `stopped()` is true
    (exit 0). A Fatal error is raised to the caller. Retry outcomes just wait for the next tick."""
    while not stopped():
        if run().status is Status.MANUAL_CHECK:
            return EXIT_MANUAL_CHECK
        sleep(interval_seconds())
    return 0


def eprint(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
