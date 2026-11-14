import base64
import hashlib
import json
import re
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from solders.keypair import Keypair

from autopay.api import Kind, Method
from autopay.config import Config, ConfigError
from autopay.payers import make_payer
from autopay.payers.evm import ERC20_ABI, EvmPayer, check_chain_id
from autopay.payers.monero import MoneroPayer
from autopay.payers.solana import SolanaPayer, parse_solana_key
from autopay.payers.utxo import UtxoPayer


@dataclass
class Seen:
    body: str
    auth: str | None


Reply = tuple[int, dict[str, str], str]


@contextmanager
def stub(reply: Callable[[Seen, int], Reply]) -> Iterator[tuple[str, list[Seen]]]:
    """An HTTP server on a free port. `reply` gets the request and its number, and returns the answer."""
    requests: list[Seen] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
            seen = Seen(body, self.headers.get("Authorization"))
            requests.append(seen)
            status, headers, text = reply(seen, len(requests))
            data = text.encode()
            self.send_response(status)
            for name, value in {"Content-Type": "application/json", **headers}.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", requests
    finally:
        server.shutdown()
        server.server_close()


def test_utxo_the_amount_is_spliced_into_the_json_as_a_raw_number_literal() -> None:
    with stub(lambda *_: (200, {}, '{"result":"abc123","error":null,"id":"autopay"}')) as (url, requests):
        txid = UtxoPayer(url, "user", "pass").send("bcrt1qexample", "BTC", "0.00012345")
    assert txid == "abc123"
    assert '"params":["bcrt1qexample",0.00012345]' in requests[0].body
    assert requests[0].auth == "Basic " + base64.b64encode(b"user:pass").decode()


def test_utxo_a_whole_amount_and_a_leading_zero_stay_valid_json_and_bad_amounts_are_refused() -> None:
    with stub(lambda *_: (200, {}, '{"result":"t","error":null}')) as (url, requests):
        payer = UtxoPayer(url, "u", "p")
        payer.send("addr", "BTC", "50")
        payer.send("addr", "BTC", "007.50")
        assert '"params":["addr",50]' in requests[0].body
        assert '"params":["addr",7.50]' in requests[1].body
        json.loads(requests[1].body)
        with pytest.raises(ValueError):
            payer.send("addr", "BTC", "1e3")
        with pytest.raises(ValueError):
            payer.send("addr", "BTC", "0.123456789")
        assert len(requests) == 2


def test_utxo_an_rpc_error_is_thrown() -> None:
    body = '{"result":null,"error":{"code":-6,"message":"Insufficient funds"}}'
    with stub(lambda *_: (500, {}, body)) as (url, _):
        with pytest.raises(RuntimeError, match="Insufficient funds"):
            UtxoPayer(url, "u", "p").send("a", "BTC", "1")


def test_monero_the_amount_is_an_integer_in_atomic_units_no_auth_without_a_user() -> None:
    with stub(lambda *_: (200, {}, '{"id":"0","jsonrpc":"2.0","result":{"tx_hash":"deadbeef"}}')) as (
        url,
        requests,
    ):
        txid = MoneroPayer(f"{url}/json_rpc").send("44Addr", "XMR", "1.5")
    assert txid == "deadbeef"
    assert len(requests) == 1
    assert requests[0].auth is None
    assert '"amount":1500000000000' in requests[0].body
    sent = json.loads(requests[0].body)
    assert sent["method"] == "transfer"
    assert sent["params"]["destinations"] == [{"amount": 1500000000000, "address": "44Addr"}]


def md5(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()


def test_monero_digest_auth_answers_the_challenge_when_a_user_is_set() -> None:
    challenge = 'Digest realm="wallet", qop="auth", nonce="n0nce", algorithm=MD5'

    def reply(seen: Seen, _: int) -> Reply:
        if not seen.auth:
            return 401, {"www-authenticate": challenge}, "{}"

        def get(key: str) -> str | None:
            m = re.search(rf'{key}=(?:"([^"]*)"|([^,\s]+))', seen.auth or "")
            return (m.group(1) or m.group(2)) if m else None

        ha1 = md5("alice:wallet:secret")
        ha2 = md5("POST:/json_rpc")
        expected = md5(f"{ha1}:n0nce:{get('nc')}:{get('cnonce')}:auth:{ha2}")
        ok = get("response") == expected and get("username") == "alice" and get("uri") == "/json_rpc"
        return (200, {}, '{"result":{"tx_hash":"cafe"}}') if ok else (401, {"www-authenticate": challenge}, "{}")

    with stub(reply) as (url, requests):
        txid = MoneroPayer(f"{url}/json_rpc", "alice", "secret").send("44A", "XMR", "2")
    assert txid == "cafe"
    assert len(requests) == 2


def test_monero_wrong_credentials_are_reported() -> None:
    challenge = 'Digest realm="wallet", qop="auth", nonce="n0nce"'
    with stub(lambda *_: (401, {"www-authenticate": challenge}, "{}")) as (url, _):
        with pytest.raises(RuntimeError, match="refused the credentials"):
            MoneroPayer(f"{url}/json_rpc", "alice", "wrong").send("44A", "XMR", "2")


def test_monero_a_non_json_error_page_is_reported_clearly() -> None:
    with stub(lambda *_: (500, {"Content-Type": "text/html"}, "<html>oops</html>")) as (url, _):
        with pytest.raises(RuntimeError, match=r"HTTP 500.*not JSON"):
            MoneroPayer(f"{url}/json_rpc").send("44A", "XMR", "1")


OVERRIDE = "0x1111111111111111111111111111111111111111"
KEY = "0x" + "11" * 32


def test_evm_the_erc20_transfer_abi_has_no_outputs_ethereum_usdt_returns_nothing() -> None:
    transfer = next(e for e in ERC20_ABI if e["type"] == "function" and e["name"] == "transfer")
    assert transfer["outputs"] == []
    # The payer is built with a token override, as TOKEN_ADDRESS would give it.
    payer = EvmPayer("http://127.0.0.1:1", KEY, "ethereum", OVERRIDE)
    assert payer.token_for("USDT") == OVERRIDE


def test_evm_a_node_of_the_other_mainnet_is_refused_other_chain_ids_are_allowed() -> None:
    with pytest.raises(ConfigError):
        check_chain_id("bsc", 1)
    with pytest.raises(ConfigError, match=r"chain id 56.*NETWORK is ethereum"):
        check_chain_id("ethereum", 56)
    for network, chain_id in [("ethereum", 1), ("bsc", 56), ("ethereum", 31337), ("bsc", 97)]:
        check_chain_id(network, chain_id)


def test_evm_check_and_send_refuse_a_wrong_node_before_anything_is_signed() -> None:
    methods: list[str] = []

    def node(seen: Seen, _: int) -> Reply:
        request = json.loads(seen.body)
        methods.append(request["method"])
        return 200, {}, json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": "0x1"})

    with stub(node) as (url, _):
        payer = EvmPayer(url, KEY, "bsc")
        with pytest.raises(ConfigError):
            payer.check()
        with pytest.raises(ConfigError, match=r"ethereum node \(chain id 1\)"):
            payer.send(OVERRIDE, "BNB", "1")
    assert set(methods) == {"eth_chainId"}


def test_evm_address_is_derived_from_the_key() -> None:
    payer = EvmPayer("http://127.0.0.1:1", KEY, "bsc")
    assert re.fullmatch(r"0x[0-9a-fA-F]{40}", payer.address())
    assert payer.token_for("USDC") == "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
    assert payer.token_for("BNB") is None
    with pytest.raises(RuntimeError, match="no token contract"):
        payer.token_for("DAI")


def test_evm_a_native_coin_is_never_a_token_even_with_token_address_set_an_unknown_coin_throws() -> None:
    eth = EvmPayer("http://127.0.0.1:1", KEY, "ethereum", OVERRIDE)
    assert eth.token_for("ETH") is None
    no_override = EvmPayer("http://127.0.0.1:1", KEY, "ethereum")
    assert no_override.token_for("ETH") is None
    with pytest.raises(RuntimeError, match="TOKEN_ADDRESS"):
        no_override.token_for("DAI")


def test_solana_sol_is_native_even_with_token_address_set_an_unknown_coin_throws() -> None:
    key = json.dumps(list(bytes(Keypair())))
    sol = SolanaPayer("http://127.0.0.1:1", key, OVERRIDE)
    assert sol.mint_for("SOL") is None
    assert sol.mint_for("USDT") == OVERRIDE
    plain = SolanaPayer("http://127.0.0.1:1", key)
    assert plain.mint_for("USDC") == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    with pytest.raises(RuntimeError, match="TOKEN_ADDRESS"):
        plain.mint_for("DAI")


def test_solana_the_key_is_a_base58_secret_key_or_a_json_byte_array() -> None:
    raw = bytes(range(1, 65))
    assert parse_solana_key(json.dumps(list(raw))) == raw
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(raw, "big")
    text = ""
    while n > 0:
        n, rem = divmod(n, 58)
        text = alphabet[rem] + text
    assert parse_solana_key(text) == raw
    assert parse_solana_key(f" {text}\n") == raw
    for bad in ["not a key!", "[1,2,3]", "[256," + ",".join(["1"] * 63) + "]"]:
        with pytest.raises(ValueError):
            parse_solana_key(bad)


def config(network: str, coin: str) -> Config:
    return Config(
        key="k",
        api="http://x",
        network=network,
        coin=coin,
        threshold_usd=10,
        topup_usd=50,
        max_per_day_usd=100,
        check_interval=60,
        dry_run=False,
        state_file="x",
        method=Method(coin=coin, network=network, kind=Kind.INVOICE, min_usd=5, max_usd=100),
    )


def test_make_payer_picks_the_family_and_names_a_missing_variable() -> None:
    with pytest.raises(ConfigError, match="EVM_RPC_URL"):
        make_payer(config("bsc", "USDT"), {})
    with pytest.raises(ConfigError, match="Tron"):
        make_payer(config("tron", "USDT"), {})
    env = {"WALLET_RPC_URL": "http://127.0.0.1:1", "WALLET_RPC_USER": "u", "WALLET_RPC_PASSWORD": "p"}
    assert isinstance(make_payer(config("bitcoin", "BTC"), env), UtxoPayer)
    assert isinstance(make_payer(config("monero", "XMR"), {"MONERO_WALLET_RPC_URL": "http://127.0.0.1:1"}), MoneroPayer)
