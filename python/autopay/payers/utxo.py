import json
import re

import httpx

from ..amounts import to_base_units

DECIMALS = 8
TIMEOUT_SECONDS = 120.0


class UtxoPayer:
    """Bitcoin Core / Litecoin Core wallet over JSON-RPC (`sendtoaddress`), with basic auth."""

    def __init__(self, url: str, user: str, password: str) -> None:
        self._url = url
        self._auth = httpx.BasicAuth(user, password)

    def address(self) -> str:
        raise RuntimeError("the wallet address is not used for this network")

    def send(self, to: str, coin: str, amount_crypto: str) -> str:
        # Checks the string is a plain decimal with at most 8 decimals; the value itself is not used.
        to_base_units(amount_crypto, DECIMALS)
        # The amount must reach the node as the exact decimal digits. A float could change them, so the
        # number literal is spliced into the text. Leading zeros are not valid JSON and are dropped.
        literal = re.sub(r"^0+(?=[0-9])", "", amount_crypto)
        body = f'{{"jsonrpc":"1.0","id":"autopay","method":"sendtoaddress","params":[{json.dumps(to)},{literal}]}}'
        res = httpx.post(
            self._url,
            content=body,
            headers={"Content-Type": "application/json"},
            auth=self._auth,
            timeout=TIMEOUT_SECONDS,
        )
        # Bitcoin Core answers errors with HTTP 500 and a JSON body, so read the body first.
        try:
            answer = res.json()
        except ValueError:
            raise RuntimeError(f"wallet RPC answered HTTP {res.status_code}") from None
        if not isinstance(answer, dict):
            raise RuntimeError(f"wallet RPC answered HTTP {res.status_code}")
        error = answer.get("error")
        if error:
            message = error.get("message") if isinstance(error, dict) else None
            raise RuntimeError(f"wallet RPC error: {message or 'unknown'}")
        result = answer.get("result")
        if not isinstance(result, str):
            raise RuntimeError("wallet RPC returned no transaction id")
        return result
