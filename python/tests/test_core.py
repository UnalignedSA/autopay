import json
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest

from autopay.api import ApiError, Deposit, DepositEntry, Invoice, Kind, Method
from autopay.config import Config
from autopay.core import Fatal, Outcome, Status, step, watch_loop
from autopay.state import Phase, StateStore, Topup

NOW = 1_800_000_000_000
MINUTE = 60_000
HOUR = 60 * MINUTE


def invoice(invoice_id: str, **over: Any) -> Invoice:
    fields: dict[str, Any] = {
        "id": invoice_id,
        "coin": "USDT",
        "network": "bsc",
        "amount_usd": 50,
        "amount_crypto": "50.00",
        "address": "0xinvoice",
        "created_at": NOW,
        "expires_at": NOW + 30 * MINUTE,
        "status": "waiting",
    }
    return Invoice(**{**fields, **over})


def deposit(**over: Any) -> Deposit:
    fields: dict[str, Any] = {
        "network": "solana",
        "coins": ["USDT", "USDC"],
        "address": "SoLaddress",
        "deposits": [],
    }
    return Deposit(**{**fields, **over})


@dataclass
class FakeApi:
    calls: list[str] = field(default_factory=list)
    created: list[dict[str, Any]] = field(default_factory=list)
    balance_value: float | ApiError = 3
    statuses: dict[str, str] = field(default_factory=dict)
    next: Invoice | Deposit = field(default_factory=lambda: invoice("inv-1"))
    deposits: list[DepositEntry] = field(default_factory=list)

    def balance(self) -> float:
        self.calls.append("balance")
        if isinstance(self.balance_value, ApiError):
            raise self.balance_value
        return self.balance_value

    def create_payment(self, body: dict[str, Any]) -> Invoice | Deposit:
        self.calls.append("create")
        self.created.append(body)
        return self.next

    def get_payment(self, payment_id: str) -> Invoice:
        self.calls.append(f"get {payment_id}")
        return invoice(payment_id, status=self.statuses.get(payment_id, "waiting"))

    def deposit(self, network: str) -> Deposit:
        self.calls.append(f"deposit {network}")
        return deposit(deposits=self.deposits)


@dataclass
class FakePayer:
    sent: list[dict[str, str]] = field(default_factory=list)
    fail_with: Exception | None = None

    def address(self) -> str:
        return "0xwallet"

    def send(self, to: str, coin: str, amount: str) -> str:
        if self.fail_with:
            raise self.fail_with
        self.sent.append({"to": to, "coin": coin, "amount": amount})
        return "0xtxid"


def record(**over: Any) -> Topup:
    fields: dict[str, Any] = {
        "id": "inv-1",
        "kind": Kind.INVOICE,
        "network": "bsc",
        "coin": "USDT",
        "amount_usd": 50,
        "amount_crypto": "50.00",
        "address": "0xinvoice",
        "expires_at": NOW + 30 * MINUTE,
        "phase": Phase.CREATED,
        "txid": None,
        "created_at": NOW,
        "sent_at": None,
        "result": None,
    }
    return Topup(**{**fields, **over})


class Harness:
    """One temporary state file, a fake API and a fake wallet."""

    def __init__(self, tmp_path: Path) -> None:
        self.path = tmp_path / "state.json"
        self.store = StateStore(self.path)
        self.api = FakeApi()
        self.payer = FakePayer()

    def config(self, **over: Any) -> Config:
        base = Config(
            key="key",
            api="https://example.test/v1",
            network="bsc",
            coin="USDT",
            threshold_usd=10,
            topup_usd=50,
            max_per_day_usd=100,
            check_interval=60,
            dry_run=False,
            state_file=str(self.path),
            method=Method(coin="USDT", network="bsc", kind=Kind.INVOICE, min_usd=5, max_usd=50000),
        )
        return replace(base, **over)

    def run(self, cfg: Config | None = None, at: int = NOW, out: Any = None) -> Outcome:
        return step(cfg or self.config(), self.api, self.payer, self.store, lambda: at, out or (lambda _: None))

    def save(self, *topups: Topup) -> None:
        self.store.save([*topups])

    @property
    def topups(self) -> list[Topup]:
        return self.store.load()


@pytest.fixture
def h(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


def solana_config(h: Harness, **over: Any) -> Config:
    return h.config(
        network="solana",
        method=Method(coin="USDT", network="solana", kind=Kind.DEPOSIT, min_usd=1, max_usd=None),
        **over,
    )


def test_t1_balance_above_the_threshold_does_nothing(h: Harness) -> None:
    h.api.balance_value = 20
    assert h.run().status is Status.IDLE
    assert h.api.calls == ["balance"]
    assert h.payer.sent == []


def test_t2_low_balance_creates_an_invoice_and_sends_the_exact_amount(h: Harness) -> None:
    assert h.run().status is Status.SENT
    assert h.api.created == [{"amount_usd": 50, "coin": "USDT", "network": "bsc"}]
    assert h.payer.sent == [{"to": "0xinvoice", "coin": "USDT", "amount": "50.00"}]
    [rec] = h.topups
    assert rec.phase is Phase.SENT
    assert rec.txid == "0xtxid"
    assert rec.sent_at == NOW


def test_t2b_the_refund_address_is_passed_when_configured(h: Harness) -> None:
    h.run(h.config(refund_address="0xrefund"))
    assert h.api.created == [{"amount_usd": 50, "coin": "USDT", "network": "bsc", "refund_address": "0xrefund"}]


def test_t3_a_record_in_sending_needs_a_manual_check(h: Harness) -> None:
    h.save(record(phase=Phase.SENDING))
    assert h.run().status is Status.MANUAL_CHECK
    assert h.api.calls == []
    assert h.payer.sent == []


def test_t4_a_paid_invoice_is_done_and_the_next_cycle_tops_up_again(h: Harness) -> None:
    h.save(record(phase=Phase.SENT, txid="0xold", sent_at=NOW - 3 * HOUR))
    h.api.statuses["inv-1"] = "paid"
    h.run()
    assert h.topups[0].phase is Phase.DONE
    assert h.topups[0].result == "paid"
    h.api.next = invoice("inv-2")
    assert h.run().status is Status.SENT
    assert len(h.topups) == 2


def test_t4b_a_sent_invoice_still_confirming_stays_pending(h: Harness) -> None:
    h.save(record(phase=Phase.SENT, txid="0xold", sent_at=NOW))
    h.api.statuses["inv-1"] = "confirming"
    assert h.run().status is Status.PENDING
    assert h.topups[0].phase is Phase.SENT


def test_t5_a_sent_invoice_that_expired_needs_a_manual_check(h: Harness) -> None:
    h.save(record(phase=Phase.SENT, txid="0xold", sent_at=NOW))
    h.api.statuses["inv-1"] = "expired"
    assert h.run().status is Status.MANUAL_CHECK
    assert "create" not in h.api.calls


def test_t6_a_created_invoice_that_expired_is_closed_without_sending(h: Harness) -> None:
    h.save(record(phase=Phase.CREATED))
    h.api.statuses["inv-1"] = "expired"
    h.run()
    assert h.topups[0].phase is Phase.DONE
    assert h.topups[0].result == "expired"
    assert h.payer.sent == []
    assert "create" not in h.api.calls


def test_t6b_a_created_invoice_that_is_still_open_is_sent_after_a_restart(h: Harness) -> None:
    h.save(record(phase=Phase.CREATED))
    assert h.run().status is Status.SENT
    assert len(h.payer.sent) == 1
    assert "create" not in h.api.calls


def test_t7_the_daily_cap_stops_a_topup_that_would_exceed_it(h: Harness) -> None:
    h.save(record(id="old", phase=Phase.DONE, result="paid", amount_usd=45, sent_at=NOW - 2 * HOUR))
    result = h.run(h.config(topup_usd=10, max_per_day_usd=50))
    assert result.status is Status.DAILY_CAP
    assert "create" not in h.api.calls


def test_t7b_sends_older_than_24_hours_do_not_count(h: Harness) -> None:
    h.save(record(id="old", phase=Phase.DONE, result="paid", amount_usd=45, sent_at=NOW - 25 * HOUR))
    h.api.next = invoice("inv-1", amount_usd=10, amount_crypto="10.00")
    assert h.run(h.config(topup_usd=10, max_per_day_usd=50)).status is Status.SENT


def test_the_daily_cap_log_shows_what_was_already_sent(h: Harness) -> None:
    h.save(record(id="old", phase=Phase.DONE, result="paid", amount_usd=45, sent_at=NOW - 2 * HOUR))
    lines: list[str] = []
    h.run(h.config(topup_usd=10, max_per_day_usd=50), out=lines.append)
    assert lines == ["daily cap reached (45/50 USD in 24h)"]


def test_t8_a_deposit_method_sends_the_amount_1_to_1_and_waits_for_the_credit(h: Harness) -> None:
    cfg = solana_config(h, topup_usd=10)
    h.api.next = deposit()
    assert h.run(cfg).status is Status.SENT
    assert h.api.created == [{"coin": "USDT", "network": "solana"}]
    assert h.payer.sent == [{"to": "SoLaddress", "coin": "USDT", "amount": "10"}]
    assert h.topups[0].id == "deposit:0xtxid"
    assert h.topups[0].kind is Kind.DEPOSIT

    h.api.deposits = [DepositEntry(tx_hash="0xtxid", credited=False)]
    assert h.run(cfg).status is Status.PENDING
    h.api.deposits = [DepositEntry(tx_hash="0xtxid", credited=True)]
    h.run(cfg)
    assert h.topups[0].phase is Phase.DONE
    assert h.topups[0].result == "credited"


def test_t9_dry_run_creates_the_payment_but_sends_nothing_and_leaves_the_state_file_unchanged(
    h: Harness,
) -> None:
    h.save(record(id="old", phase=Phase.DONE, result="paid"))
    before = h.path.read_text()
    lines: list[str] = []
    result = h.run(h.config(dry_run=True), out=lines.append)
    assert result.status is Status.IDLE
    assert len(h.api.created) == 1
    assert h.payer.sent == []
    assert h.path.read_text() == before
    assert "would send 50.00 USDT on bsc to 0xinvoice" in lines


def test_t10_a_failing_send_leaves_the_record_in_sending_and_asks_for_a_manual_check(h: Harness) -> None:
    h.payer.fail_with = RuntimeError("rpc down")
    assert h.run().status is Status.MANUAL_CHECK
    assert h.topups[0].phase is Phase.SENDING
    h.payer.fail_with = None
    assert h.run().status is Status.MANUAL_CHECK
    assert h.payer.sent == []


def test_t11_a_corrupt_state_file_is_fatal_and_calls_nothing(h: Harness) -> None:
    h.path.write_text("{not json")
    with pytest.raises(Fatal):
        h.run()
    assert h.api.calls == []


def test_t12_an_invoice_about_to_expire_is_not_paid(h: Harness) -> None:
    h.save(record(phase=Phase.CREATED, expires_at=NOW + 4 * MINUTE))
    assert h.run().status is Status.PENDING
    assert h.payer.sent == []


def test_t13_a_503_is_a_retry_not_a_failure(h: Harness) -> None:
    h.api.balance_value = ApiError("unavailable", status=503, transient=True)
    assert h.run().status is Status.RETRY


def test_t14_a_401_is_fatal(h: Harness) -> None:
    h.api.balance_value = ApiError("unauthorized", status=401, code="unauthorized", transient=False)
    with pytest.raises(Fatal):
        h.run()


def test_t14b_a_403_is_fatal_and_explains_the_reseller_case(h: Harness) -> None:
    h.api.balance_value = ApiError("forbidden", status=403, code="forbidden", transient=False)
    with pytest.raises(Fatal, match="reseller"):
        h.run()


def test_a_429_is_a_retry(h: Harness) -> None:
    h.api.balance_value = ApiError("slow down", status=429, transient=True)
    assert h.run().status is Status.RETRY


def test_a_refunded_invoice_is_done(h: Harness) -> None:
    h.save(record(phase=Phase.SENT, txid="0xold", sent_at=NOW))
    h.api.statuses["inv-1"] = "refunded"
    h.run()
    assert h.topups[0].phase is Phase.DONE
    assert h.topups[0].result == "refunded"


def test_a_created_invoice_that_is_not_waiting_any_more_is_not_paid_again(h: Harness) -> None:
    h.save(record(phase=Phase.CREATED))
    h.api.statuses["inv-1"] = "confirming"
    assert h.run().status is Status.PENDING
    assert h.payer.sent == []


def test_the_daily_cap_counts_a_hand_edited_record_that_has_no_sent_at(h: Harness) -> None:
    h.save(record(id="old", phase=Phase.DONE, result="paid", amount_usd=45, txid="0xold", created_at=NOW - 2 * HOUR))
    assert h.run(h.config(topup_usd=10, max_per_day_usd=50)).status is Status.DAILY_CAP
    assert "create" not in h.api.calls


def test_an_expired_record_that_never_sent_anything_does_not_count_towards_the_cap(h: Harness) -> None:
    h.save(record(id="old", phase=Phase.DONE, result="expired", amount_usd=45, created_at=NOW - 2 * HOUR))
    h.api.next = invoice("inv-1", amount_usd=10, amount_crypto="10.00")
    assert h.run(h.config(topup_usd=10, max_per_day_usd=50)).status is Status.SENT


@pytest.mark.parametrize("wrong", [{"coin": "USDC"}, {"network": "ethereum"}, {"amount_usd": 5000}])
def test_an_invoice_that_is_not_what_was_asked_for_is_never_paid(h: Harness, wrong: dict[str, Any]) -> None:
    h.api.next = invoice("inv-x", **wrong)
    with pytest.raises(Fatal):
        h.run()
    assert h.payer.sent == []
    assert not h.path.exists()


def test_a_deposit_on_the_wrong_network_is_never_paid(h: Harness) -> None:
    cfg = solana_config(h)
    h.api.next = deposit(coins=["USDC"])
    with pytest.raises(Fatal):
        h.run(cfg)
    h.api.next = deposit(network="bsc")
    with pytest.raises(Fatal):
        h.run(cfg)
    assert h.payer.sent == []


@pytest.mark.parametrize(
    "change",
    [
        {"phase": "sendng"},
        {"network": 7},
        {"txid": 5},
        {"sentAt": "1793925000000"},
        {"expiresAt": "soon"},
        {"coin": None},
        {"amountUsd": True},
        {"kind": "other"},
    ],
)
def test_a_state_file_with_a_malformed_record_is_fatal(h: Harness, change: dict[str, Any]) -> None:
    h.save(record())
    state = json.loads(h.path.read_text())
    state["topups"][0].update(change)
    h.path.write_text(json.dumps(state))
    with pytest.raises(Fatal):
        h.run()
    assert h.api.calls == []


def test_a_state_file_with_a_missing_field_is_fatal(h: Harness) -> None:
    h.save(record())
    state = json.loads(h.path.read_text())
    del state["topups"][0]["address"]
    h.path.write_text(json.dumps(state))
    with pytest.raises(Fatal):
        h.run()


def test_a_missing_state_file_is_empty_but_an_unreadable_one_is_fatal(h: Harness) -> None:
    assert h.store.load() == []
    h.path.mkdir()
    with pytest.raises(Fatal):
        h.run()


def test_the_state_file_keeps_the_documented_format(h: Harness) -> None:
    h.run()
    state = json.loads(h.path.read_text())
    assert state["version"] == 1
    assert list(state["topups"][0]) == [
        "id",
        "kind",
        "network",
        "coin",
        "amountUsd",
        "amountCrypto",
        "address",
        "expiresAt",
        "phase",
        "txid",
        "createdAt",
        "sentAt",
        "result",
    ]
    assert state["topups"][0]["kind"] == "invoice"
    assert state["topups"][0]["phase"] == "sent"


def test_the_balance_log_prints_numbers_without_a_trailing_zero(h: Harness) -> None:
    h.api.balance_value = 42.5
    lines: list[str] = []
    h.run(h.config(threshold_usd=10.0), out=lines.append)
    assert lines == ["balance 42.5 >= threshold 10"]


def test_watch_runs_cycle_after_cycle_tolerates_a_retry_and_stops_on_a_manual_check() -> None:
    outcomes = iter(
        [
            Outcome(Status.IDLE),
            Outcome(Status.RETRY, "x"),
            Outcome(Status.IDLE),
            Outcome(Status.MANUAL_CHECK, "y"),
        ]
    )
    runs = 0
    sleeps: list[float] = []

    def run() -> Outcome:
        nonlocal runs
        runs += 1
        return next(outcomes)

    code = watch_loop(run, sleeps.append, lambda: 60, lambda: False)
    assert code == 3
    assert runs == 4
    assert sleeps == [60, 60, 60]


def test_watch_stops_with_0_when_asked_to() -> None:
    stop = False
    runs = 0

    def run() -> Outcome:
        nonlocal runs
        runs += 1
        return Outcome(Status.IDLE)

    def sleep(_: float) -> None:
        nonlocal stop
        stop = True

    assert watch_loop(run, sleep, lambda: 60, lambda: stop) == 0
    assert runs == 1


def test_watch_lets_a_fatal_error_through() -> None:
    def run() -> Outcome:
        raise Fatal("bad key")

    with pytest.raises(Fatal):
        watch_loop(run, lambda _: None, lambda: 60, lambda: False)
