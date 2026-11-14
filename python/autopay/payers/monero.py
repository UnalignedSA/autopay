import json

import httpx

from ..amounts import to_base_units
from ..core import Payer

DECIMALS = 12
TIMEOUT_SECONDS = 120.0


class MoneroPayer(Payer):
    """monero-wallet-rpc `transfer`. Digest auth is used only when a user is set."""

    def __init__(self, url: str, user: str = "", password: str = "") -> None:
        self._url = url
        self._auth = httpx.DigestAuth(user, password) if user else None

    def address(self) -> str:
        raise RuntimeError("the wallet address is not used for this network")

    def send(self, to: str, coin: str, amount_crypto: str) -> str:
        atomic = to_base_units(amount_crypto, DECIMALS)
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "0",
                "method": "transfer",
                "params": {"destinations": [{"amount": atomic, "address": to}], "priority": 0},
            },
            separators=(",", ":"),
        )
        res = httpx.post(
            self._url,
            content=body,
            headers={"Content-Type": "application/json"},
            auth=self._auth,
            timeout=TIMEOUT_SECONDS,
        )
        if res.status_code == 401:
            raise RuntimeError("wallet RPC refused the credentials")
        try:
            answer = res.json()
        except ValueError:
            raise RuntimeError(f"wallet RPC answered HTTP {res.status_code} with a body that is not JSON") from None
        if not isinstance(answer, dict):
            raise RuntimeError(f"wallet RPC answered HTTP {res.status_code} with a body that is not JSON")
        error = answer.get("error")
        if error:
            message = error.get("message") if isinstance(error, dict) else None
            raise RuntimeError(f"wallet RPC error: {message or 'unknown'}")
        tx_hash = (answer.get("result") or {}).get("tx_hash")
        if not tx_hash:
            raise RuntimeError("wallet RPC returned no transaction hash")
        return str(tx_hash)
