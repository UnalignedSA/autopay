import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from autopay.api import Api, ApiError, Deposit, Invoice

last_auth: list[str | None] = []

#: What the API answers: snake_case, seconds.
INVOICE = {
    "kind": "invoice",
    "id": "inv-1",
    "coin": "USDT",
    "network": "bsc",
    "amount_usd": 50,
    "amount_crypto": "50.00",
    "address": "0xa",
    "created_at": 1793925000,
    "expires_at": 1793926800,
    "required_confirmations": 15,
    "status": "waiting",
    "payments": [],
}
#: The same invoice with the field names and milliseconds of the API before 2.0.
OLD_INVOICE = {
    "kind": "invoice",
    "id": "inv-1",
    "coin": "USDT",
    "network": "bsc",
    "amountUsd": 50,
    "amountCrypto": "50.00",
    "address": "0xa",
    "createdAt": 1793925000000,
    "expiresAt": 1793926800000,
    "status": "waiting",
}


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
            self.reply(
                200,
                '{"methods":[{"coin":"USDT","network":"bsc","kind":"invoice","min_usd":5,"max_usd":null,'
                '"rate_usd":1,"confirmations":15}]}',
            )
        elif path.endswith("/full"):
            self.reply(409, '{"error":{"code":"limit_reached","message":"too many open"}}')
        elif path.endswith("/limited"):
            self.reply(429, '{"error":{"code":"rate_limited","message":"slow"}}')
        elif path.startswith("/payments/deposit/"):
            self.reply(
                200,
                '{"kind":"deposit","network":"solana","coins":["USDT"],"address":"A",'
                '"min_usd":1,"required_confirmations":1,"deposits":[{"coin":"USDT","amount":"5","usd":5,'
                '"tx_hash":"t","at":1793925000,"confirmations":3,"credited":true}]}',
            )
        elif path.startswith("/payments/inv-1"):
            self.reply(200, json.dumps(INVOICE))
        else:
            self.reply(
                400,
                '{"error":{"code":"invalid_request","message":"nope","request_id":"req_1"}}',
                {"X-Request-Id": "req_1"},
            )

    def reply(self, status: int, body: str, headers: dict[str, str] | None = None) -> None:
        data = body.encode()
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
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


def test_a_400_carries_the_api_error_code_and_the_request_id_and_is_not_transient(base: str) -> None:
    with pytest.raises(ApiError) as err:
        Api(base, "k").get_payment("bad")
    assert err.value.status == 400
    assert err.value.code == "invalid_request"
    assert not err.value.transient
    assert str(err.value) == "GET /payments/bad: 400 invalid_request nope (request req_1)"


def test_a_409_too_many_open_invoices_is_not_transient(base: str) -> None:
    with pytest.raises(ApiError) as err:
        Api(base, "k").get_payment("full")
    assert (err.value.status, err.value.code, err.value.transient) == (409, "limit_reached", False)


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


@pytest.mark.parametrize(
    "answer",
    [
        "[]",
        "null",
        "{}",
        '{"kind":"deposit"}',
        json.dumps(OLD_INVOICE),
        json.dumps(INVOICE | {"expires_at": "1793926800"}),
        json.dumps(INVOICE | {"created_at": None}),
    ],
)
def test_a_malformed_payment_answer_is_a_transient_error(answer: str) -> None:
    with serve(answer) as base, pytest.raises(ApiError) as err:
        Api(base, "k").create_payment({})
    assert err.value.transient


@pytest.mark.parametrize("answer", ["[]", "null", "{}", '{"methods":null}', '{"methods":[{"coin":"USDT"}]}'])
def test_a_malformed_methods_answer_is_a_transient_error(answer: str) -> None:
    with serve(answer) as base, pytest.raises(ApiError) as err:
        Api(base, "k").methods()
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
    # The API's seconds become the program's milliseconds.
    assert (invoice.created_at, invoice.expires_at) == (1793925000000, 1793926800000)
    deposit = api.deposit("solana")
    assert isinstance(deposit, Deposit)
    assert deposit.deposits[0].tx_hash == "t"
    assert deposit.deposits[0].credited is True
