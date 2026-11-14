"""The state file: every top-up, so that a restart never pays twice."""

import json
import math
import os
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

from .api import Kind


class Phase(StrEnum):
    CREATED = "created"
    SENDING = "sending"
    SENT = "sent"
    DONE = "done"


@dataclass
class Topup:
    #: Invoice id, or "deposit:<txid>" for a deposit ("deposit:pending" until the txid is known).
    id: str
    kind: Kind
    network: str
    coin: str
    amount_usd: float
    amount_crypto: str
    address: str
    #: Milliseconds since 1970. None for a deposit address, which never expires.
    expires_at: int | None
    phase: Phase
    txid: str | None
    created_at: int
    sent_at: int | None
    #: Final status: paid, expired, refunded or credited.
    result: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind.value,
            "network": self.network,
            "coin": self.coin,
            "amountUsd": self.amount_usd,
            "amountCrypto": self.amount_crypto,
            "address": self.address,
            "expiresAt": self.expires_at,
            "phase": self.phase.value,
            "txid": self.txid,
            "createdAt": self.created_at,
            "sentAt": self.sent_at,
            "result": self.result,
        }

    @classmethod
    def from_json(cls, raw: Any) -> "Topup":
        """The file is meant to be hand-edited after a manual check, so every field is verified."""
        if not isinstance(raw, dict):
            raise ValueError("a record is not an object")
        try:
            return cls(
                id=string(raw["id"]),
                kind=Kind(raw["kind"]),
                network=string(raw["network"]),
                coin=string(raw["coin"]),
                amount_usd=number(raw["amountUsd"]),
                amount_crypto=string(raw["amountCrypto"]),
                address=string(raw["address"]),
                expires_at=or_none(number, raw["expiresAt"]),
                phase=Phase(raw["phase"]),
                txid=or_none(string, raw["txid"]),
                created_at=number(raw["createdAt"]),
                sent_at=or_none(number, raw["sentAt"]),
                result=or_none(string, raw["result"]),
            )
        except KeyError as err:
            raise ValueError(f"field {err} is missing") from err


def string(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{value!r} is not a string")
    return value


def number(value: Any) -> Any:
    # bool is an int in Python, but true is not a number here.
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise ValueError(f"{value!r} is not a number")
    return value


def or_none(check: Any, value: Any) -> Any:
    return None if value is None else check(value)


class StateError(Exception):
    """The state file cannot be trusted. Fix or remove it by hand."""


class StateStore:
    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    def load(self) -> list[Topup]:
        """A missing file is an empty state. Anything else that is not a valid state is an error."""
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except (OSError, UnicodeDecodeError) as err:
            raise StateError(f"cannot read state file {self._path}: {err}") from err
        try:
            state = json.loads(text)
        except ValueError as err:
            raise StateError(f"state file {self._path} is not valid JSON; fix or remove it by hand") from err
        try:
            if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("topups"), list):
                raise ValueError("unknown version or shape")
            return [Topup.from_json(t) for t in state["topups"]]
        except (ValueError, TypeError) as err:
            raise StateError(
                f"state file {self._path} has an unknown format ({err}); fix or remove it by hand"
            ) from err

    def save(self, topups: list[Topup]) -> None:
        """Writes to a temporary file, fsyncs it, then renames it over the real one."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        text = json.dumps({"version": 1, "topups": [t.to_json() for t in topups]}, indent=2) + "\n"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self._path)
        try:
            # Make the rename itself durable. Not possible on every platform (Windows): best effort.
            dir_fd = os.open(self._path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass
