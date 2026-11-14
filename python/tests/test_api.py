import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from autopay.api import Api, ApiError, Deposit, Invoice

last_auth: list[str | None] = []


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        last_auth.append(self.headers.get("Authorization"))
        path = self.path
        if path.endswith("/garbage"):
            self.reply(200, "<html>")
        elif path.endswith("/cut"):
            # Promises more than it sends, then drops the connection.
            self.send_response(200)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b'{"balance"')
            self.wfile.flush()
            time.sleep(0.02)
            self.close_connection = True
        elif path == "/balance":
            self.reply(200, '{"balance": 12.5}')
        elif path == "/payments/methods":
            self.reply(200, '[{"coin":"USDT","network":"bsc","kind":"invoice","min_usd":5,"max_usd":null}]')
        elif path.endswith("/limited"):
            self.reply(429, '{"error":{"code":"rate_limited","message":"slow"}}')
        elif path.startswith("/payments/deposit/"):
            self.reply(
                200,
                '{"kind":"deposit","network":"solana","coins":["USDT"],"address":"A",'
                '"deposits":[{"txHash":"t","credited":true}]}',
            )
        elif path.startswith("/payments/inv-1"):
            self.reply(
                200,
                json.dumps(
                    {
                        "kind": "invoice",
                        "id": "inv-1",
                        "coin": "USDT",
                        "network": "bsc",
                        "amountUsd": 50,
                        "amountCrypto": "50.00",
                        "address": "0xa",
                        "createdAt": 1,
                        "expiresAt": 2,
                        "status": "waiting",
                    }
                ),
            )
        else:
            self.reply(400, '{"error":{"code":"invalid_input","message":"nope"}}')

    def reply(self, status: int, body: str) -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:
        pass


@contextmanager
def serve(body: str) -> Iterator[str]:
    """A server that answers every request with 200 and `body`."""

    class Fixed(Handler):
        def do_GET(self) -> None:
            self.reply(200, body)

        do_POST = do_GET

    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixed)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(scope="module")
def base() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def test_balance_sends_the_key_as_a_bearer_token(base: str) -> None:
    assert Api(base, "secret").balance() == 12.5
    assert last_auth[-1] == "Bearer secret"


def test_methods_is_public_no_authorization_header(base: str) -> None:
    methods = Api(base, "secret").methods()
    assert last_auth[-1] is None
    assert methods[0].coin == "USDT"
    assert methods[0].max_usd is None


def test_a_400_carries_the_api_error_code_and_is_not_transient(base: str) -> None:
    with pytest.raises(ApiError) as err:
        Api(base, "k").get_payment("bad")
    assert err.value.status == 400
    assert err.value.code == "invalid_input"
    assert not err.value.transient
    assert "nope" in str(err.value)


def test_a_429_is_transient(base: str) -> None:
    with pytest.raises(ApiError) as err:
        Api(base, "k").get_payment("limited")
    assert err.value.status == 429
    assert err.value.transient


@pytest.mark.parametrize("payment_id", ["garbage", "cut"])
def test_a_non_json_or_cut_off_200_body_is_a_transient_error(base: str, payment_id: str) -> None:
    with pytest.raises(ApiError) as err:
        Api(base, "k").get_payment(payment_id)
    assert err.value.transient


@pytest.mark.parametrize(
    "answer", ["{}", "[]", "null", '{"balance": "x"}', '{"balance": NaN}', '{"balance": Infinity}']
)
def test_a_balance_that_is_not_a_finite_number_is_a_transient_error(answer: str) -> None:
    with serve(answer) as base, pytest.raises(ApiError) as err:
        Api(base, "k").balance()
    assert err.value.transient


@pytest.mark.parametrize("answer", ["[]", "null", "{}", '{"kind":"deposit"}'])
def test_a_malformed_payment_answer_is_a_transient_error(answer: str) -> None:
    with serve(answer) as base, pytest.raises(ApiError) as err:
        Api(base, "k").create_payment({})
    assert err.value.transient


def test_a_refused_connection_is_a_transient_error() -> None:
    with pytest.raises(ApiError) as err:
        Api("http://127.0.0.1:1", "k").balance()
    assert err.value.transient


def test_answers_are_parsed_into_objects(base: str) -> None:
    api = Api(base, "k")
    invoice = api.get_payment("inv-1")
    assert isinstance(invoice, Invoice)
    assert (invoice.id, invoice.amount_usd, invoice.amount_crypto, invoice.status) == (
        "inv-1",
        50,
        "50.00",
        "waiting",
    )
    deposit = api.deposit("solana")
    assert isinstance(deposit, Deposit)
    assert deposit.deposits[0].tx_hash == "t"
    assert deposit.deposits[0].credited is True
