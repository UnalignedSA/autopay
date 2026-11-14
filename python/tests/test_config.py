import pytest

from autopay.api import Kind, Method
from autopay.config import ConfigError, load_config, preflight

METHODS = [
    Method(coin="USDT", network="bsc", kind=Kind.INVOICE, min_usd=5, max_usd=50000),
    Method(coin="USDT", network="solana", kind=Kind.DEPOSIT, min_usd=1, max_usd=None),
    Method(coin="BTC", network="bitcoin", kind=Kind.INVOICE, min_usd=5, max_usd=50000),
]

BASE = {
    "UNALIGNED_KEY": "key",
    "NETWORK": "bsc",
    "COIN": "USDT",
    "THRESHOLD_USD": "10",
    "TOPUP_USD": "50",
    "MAX_PER_DAY_USD": "100",
    "EVM_RPC_URL": "http://localhost:8545",
    "EVM_PRIVATE_KEY": "0x01",
}


def test_reads_a_valid_configuration_and_applies_defaults() -> None:
    cfg = load_config(BASE, METHODS)
    assert cfg.network == "bsc"
    assert cfg.coin == "USDT"
    assert cfg.threshold_usd == 10
    assert cfg.topup_usd == 50
    assert cfg.check_interval == 60
    assert cfg.dry_run is False
    assert cfg.state_file == "./autopay-state.json"
    assert cfg.method.kind is Kind.INVOICE


def test_strips_a_trailing_slash_from_unaligned_api() -> None:
    cfg = load_config({**BASE, "UNALIGNED_API": "https://example.test/v1/"}, METHODS)
    assert cfg.api == "https://example.test/v1"


def test_tron_is_not_supported() -> None:
    with pytest.raises(ConfigError, match="Tron is not supported"):
        load_config({**BASE, "NETWORK": "tron"}, METHODS)


def test_a_pair_that_is_not_offered_lists_the_valid_pairs() -> None:
    with pytest.raises(ConfigError) as err:
        load_config({**BASE, "COIN": "DOGE"}, METHODS)
    assert "USDT/bsc" in str(err.value)
    assert "BTC/bitcoin" in str(err.value)


def test_topup_below_the_method_minimum_is_rejected() -> None:
    with pytest.raises(ConfigError, match="TOPUP_USD"):
        load_config({**BASE, "TOPUP_USD": "3"}, METHODS)


def test_topup_above_the_method_maximum_is_rejected() -> None:
    with pytest.raises(ConfigError, match="TOPUP_USD"):
        load_config({**BASE, "TOPUP_USD": "60000", "MAX_PER_DAY_USD": "70000"}, METHODS)


def test_topup_must_be_a_whole_number() -> None:
    with pytest.raises(ConfigError, match="TOPUP_USD"):
        load_config({**BASE, "TOPUP_USD": "5.5"}, METHODS)


def test_max_per_day_must_cover_one_topup() -> None:
    with pytest.raises(ConfigError, match="MAX_PER_DAY_USD"):
        load_config({**BASE, "MAX_PER_DAY_USD": "40"}, METHODS)


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "abc"])
def test_threshold_must_be_above_zero(value: str) -> None:
    with pytest.raises(ConfigError, match="THRESHOLD_USD"):
        load_config({**BASE, "THRESHOLD_USD": value}, METHODS)


def test_check_interval_below_15_seconds_is_rejected() -> None:
    with pytest.raises(ConfigError, match="CHECK_INTERVAL"):
        load_config({**BASE, "CHECK_INTERVAL": "5"}, METHODS)


def test_a_missing_wallet_variable_is_named() -> None:
    env = {k: v for k, v in BASE.items() if k != "EVM_PRIVATE_KEY"}
    with pytest.raises(ConfigError, match="EVM_PRIVATE_KEY"):
        load_config(env, METHODS)


def test_a_missing_key_is_named() -> None:
    env = {k: v for k, v in BASE.items() if k != "UNALIGNED_KEY"}
    with pytest.raises(ConfigError, match="UNALIGNED_KEY"):
        load_config(env, METHODS)


def test_a_deposit_method_has_no_maximum_and_needs_the_solana_wallet() -> None:
    env = {**BASE, "NETWORK": "solana", "TOPUP_USD": "1", "MAX_PER_DAY_USD": "1000000"}
    with pytest.raises(ConfigError, match="SOLANA_RPC_URL"):
        load_config(env, METHODS)
    cfg = load_config({**env, "SOLANA_RPC_URL": "http://x", "SOLANA_PRIVATE_KEY": "k"}, METHODS)
    assert cfg.method.kind is Kind.DEPOSIT


def test_dry_run_1_is_read() -> None:
    assert load_config({**BASE, "DRY_RUN": "1"}, METHODS).dry_run is True


def test_preflight_checks_everything_it_can_without_the_api() -> None:
    with pytest.raises(ConfigError, match="Tron"):
        preflight({**BASE, "NETWORK": "tron"})
    with pytest.raises(ConfigError, match="UNALIGNED_KEY"):
        preflight({**BASE, "UNALIGNED_KEY": ""})
    with pytest.raises(ConfigError, match="EVM_RPC_URL"):
        preflight({**BASE, "EVM_RPC_URL": ""})
    assert preflight(BASE).topup_usd == 50


def test_token_address_with_a_native_coin_is_rejected() -> None:
    token = "0x1111111111111111111111111111111111111111"
    env = {**BASE, "NETWORK": "ethereum", "COIN": "ETH", "TOKEN_ADDRESS": token}
    with pytest.raises(ConfigError, match=r"TOKEN_ADDRESS.*native coin"):
        preflight(env)
    preflight({**BASE, "TOKEN_ADDRESS": token})
