"""The Unaligned API calls. One method per endpoint."""

import json
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, TypeVar
from urllib.parse import quote

import httpx

TIMEOUT_SECONDS = 30.0

T = TypeVar("T")


class Kind(StrEnum):
    INVOICE = "invoice"
    DEPOSIT = "deposit"


@dataclass(frozen=True)
class Method:
    coin: str
    network: str
    kind: Kind
    min_usd: float
    max_usd: float | None


@dataclass(frozen=True)
class Invoice:
    """An invoice as the program keeps it: times in milliseconds since 1970."""

    id: str
    coin: str
    network: str
    amount_usd: float
    amount_crypto: str
    address: str
    created_at: int
    expires_at: int
    #: waiting, confirming, partial, paid, expired or refunded
    status: str


@dataclass(frozen=True)
class DepositEntry:
    tx_hash: str
    credited: bool


@dataclass(frozen=True)
class Deposit:
    network: str
    coins: list[str]
    address: str
    deposits: list[DepositEntry] = field(default_factory=list)


class ApiError(Exception):
    def __init__(self, message: str, *, status: int, transient: bool, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        #: True for failures that may go away by themselves: network errors, 5xx, 429.
        self.transient = transient


class Api:
    def __init__(self, base: str, key: str) -> None:
        self._base = base
        self._key = key

    def balance(self) -> float:
        answer = self._request("GET", "/balance")
        return self._parse("GET /balance", lambda: finite_number(answer["balance"]))

    def methods(self) -> list[Method]:
        """Public: sent without the key."""
        body = self._request("GET", "/payments/methods", auth=False)
        return self._parse("GET /payments/methods", lambda: [parse_method(m) for m in as_list(body["methods"])])

    def create_payment(self, body: dict[str, Any]) -> Invoice | Deposit:
        """201 with an invoice, or 200 with the account's fixed deposit address."""
        answer = self._request("POST", "/payments", body)

        def build() -> Invoice | Deposit:
            if answer.get("kind") == "deposit" or "coins" in answer:
                return parse_deposit(answer)
            return parse_invoice(answer)

        return self._parse("POST /payments", build)

    def get_payment(self, payment_id: str) -> Invoice:
        path = f"/payments/{quote(payment_id, safe='')}"
        answer = self._request("GET", path)
        return self._parse(f"GET {path}", lambda: parse_invoice(answer))

    def deposit(self, network: str) -> Deposit:
        path = f"/payments/deposit/{quote(network, safe='')}"
        answer = self._request("GET", path)
        return self._parse(f"GET {path}", lambda: parse_deposit(answer))

    @staticmethod
    def _parse(what: str, build: Callable[[], T]) -> T:
        try:
            return build()
        except (KeyError, TypeError, ValueError, AttributeError) as err:
            # The answer is not shaped like the documented one: treat it like any other glitch.
            raise ApiError(f"{what}: unexpected response: {err!r}", status=200, transient=True) from err

    def _request(self, method: str, path: str, body: Any = None, *, auth: bool = True) -> Any:
        headers = {"Authorization": f"Bearer {self._key}"} if auth else {}
        try:
            res = httpx.request(method, self._base + path, headers=headers, json=body, timeout=TIMEOUT_SECONDS)
            content = res.content
        except httpx.HTTPError as err:
            raise ApiError(f"network error: {error_text(err)}", status=0, transient=True) from err

        if res.is_success:
            try:
                return json.loads(content)
            except ValueError as err:
                # The body was cut off or is not JSON: treat it like any other glitch and try again later.
                raise ApiError(
                    f"{method} {path}: unreadable response: {err}", status=res.status_code, transient=True
                ) from err

        code: str | None = None
        message = res.reason_phrase
        try:
            error = json.loads(content).get("error") or {}
            code = error.get("code")
            message = error.get("message") or message
        except (ValueError, AttributeError):
            pass  # not JSON: keep the status text
        # The request id is what support asks for.
        request_id = res.headers.get("x-request-id")
        parts = (f"{method} {path}:", res.status_code, code, message, request_id and f"(request {request_id})")
        text = " ".join(str(p) for p in parts if p)
        # 429 means slow down, not give up.
        raise ApiError(
            text,
            status=res.status_code,
            code=code,
            transient=res.status_code >= 500 or res.status_code == 429,
        )


def error_text(err: Exception) -> str:
    return str(err) or type(err).__name__


def finite_number(value: Any) -> float:
    """A JSON number. Python's json also reads NaN and Infinity, which are not valid amounts."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise ValueError(f"not a finite number: {value!r}")
    return value


def as_list(value: Any) -> list[Any]:
    if not isinstance(value, list):
        raise TypeError(f"not a list: {value!r}")
    return value


def milliseconds(seconds: Any) -> int:
    """The API gives times in whole seconds; the program and its state file count in milliseconds."""
    if isinstance(seconds, bool) or not isinstance(seconds, int):
        raise ValueError(f"not a time in seconds: {seconds!r}")
    return seconds * 1000


def parse_method(raw: dict[str, Any]) -> Method:
    return Method(
        coin=raw["coin"],
        network=raw["network"],
        kind=Kind(raw["kind"]),
        min_usd=raw["min_usd"],
        max_usd=raw["max_usd"],
    )


def parse_invoice(raw: dict[str, Any]) -> Invoice:
    return Invoice(
        id=raw["id"],
        coin=raw["coin"],
        network=raw["network"],
        amount_usd=raw["amount_usd"],
        amount_crypto=raw["amount_crypto"],
        address=raw["address"],
        created_at=milliseconds(raw["created_at"]),
        expires_at=milliseconds(raw["expires_at"]),
        status=raw["status"],
    )


def parse_deposit(raw: dict[str, Any]) -> Deposit:
    return Deposit(
        network=raw["network"],
        coins=list(raw["coins"]),
        address=raw["address"],
        deposits=[DepositEntry(tx_hash=d["tx_hash"], credited=d["credited"] is True) for d in raw.get("deposits", [])],
    )
