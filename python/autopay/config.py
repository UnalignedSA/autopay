"""Reads and checks the environment."""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from .api import Method

DEFAULT_API = "https://api.unaligned.pw/v1"


class ConfigError(Exception):
    """The configuration is wrong. Fix it and start again."""


@dataclass(frozen=True)
class Settings:
    """Everything that can be checked without asking the API."""

    key: str
    api: str
    network: str
    coin: str
    threshold_usd: float
    topup_usd: int
    max_per_day_usd: int
    #: Seconds.
    check_interval: int = 60
    dry_run: bool = False
    refund_address: str | None = None
    state_file: str = "./autopay-state.json"
    token_address: str | None = None


@dataclass(frozen=True)
class Config(Settings):
    """The settings plus the payment method the API offers for them."""

    method: Method = field(kw_only=True)


Env = Mapping[str, str]

#: The wallet variables each network needs.
WALLET_VARS: dict[str, list[str]] = {
    "ethereum": ["EVM_RPC_URL", "EVM_PRIVATE_KEY"],
    "bsc": ["EVM_RPC_URL", "EVM_PRIVATE_KEY"],
    "solana": ["SOLANA_RPC_URL", "SOLANA_PRIVATE_KEY"],
    "bitcoin": ["WALLET_RPC_URL", "WALLET_RPC_USER", "WALLET_RPC_PASSWORD"],
    "litecoin": ["WALLET_RPC_URL", "WALLET_RPC_USER", "WALLET_RPC_PASSWORD"],
    "monero": ["MONERO_WALLET_RPC_URL"],
}

#: The coin each network's own currency is called. Every other coin is a token.
NATIVE_COIN: dict[str, str] = {
    "ethereum": "ETH",
    "bsc": "BNB",
    "solana": "SOL",
    "bitcoin": "BTC",
    "litecoin": "LTC",
    "monero": "XMR",
}


def api_base(env: Env) -> str:
    """The API base URL: UNALIGNED_API or the public default, without a trailing slash."""
    return (env.get("UNALIGNED_API") or DEFAULT_API).rstrip("/")


def preflight(env: Env) -> Settings:
    """Everything that can be checked without asking the API. Run it before any network call."""
    key = required(env, "UNALIGNED_KEY")
    network = required(env, "NETWORK").lower()
    coin = required(env, "COIN").upper()
    if network == "tron":
        raise ConfigError("Tron is not supported by this example yet")

    threshold_usd = positive_number(required(env, "THRESHOLD_USD"))
    if threshold_usd is None:
        raise ConfigError("THRESHOLD_USD must be a number above 0")
    topup_usd = whole_number(env, "TOPUP_USD")
    max_per_day_usd = whole_number(env, "MAX_PER_DAY_USD")
    if max_per_day_usd < topup_usd:
        raise ConfigError("MAX_PER_DAY_USD must be at least TOPUP_USD")

    interval = env.get("CHECK_INTERVAL") or "60"
    if re.fullmatch(r"[0-9]+", interval) is None or int(interval) < 15:
        raise ConfigError("CHECK_INTERVAL must be a whole number of seconds, at least 15")

    if env.get("TOKEN_ADDRESS") and NATIVE_COIN.get(network) == coin:
        raise ConfigError(f"TOKEN_ADDRESS is for tokens: {coin} is the native coin of {network}, unset TOKEN_ADDRESS")

    for name in WALLET_VARS.get(network, []):
        required(env, name)

    return Settings(
        key=key,
        api=api_base(env),
        network=network,
        coin=coin,
        threshold_usd=threshold_usd,
        topup_usd=topup_usd,
        max_per_day_usd=max_per_day_usd,
        check_interval=int(interval),
        dry_run=env.get("DRY_RUN") == "1",
        refund_address=env.get("REFUND_ADDRESS") or None,
        state_file=env.get("STATE_FILE") or "./autopay-state.json",
        token_address=env.get("TOKEN_ADDRESS") or None,
    )


def load_config(env: Env, methods: list[Method]) -> Config:
    """Reads and validates the environment. `methods` is the answer of GET /payments/methods."""
    settings = preflight(env)
    network, coin, topup_usd = settings.network, settings.coin, settings.topup_usd

    method = next((m for m in methods if m.network == network and m.coin == coin), None)
    if method is None:
        pairs = ", ".join(f"{m.coin}/{m.network}" for m in methods)
        raise ConfigError(f"{coin} on {network} is not offered. Valid COIN/NETWORK pairs: {pairs}")
    if topup_usd < method.min_usd:
        raise ConfigError(f"TOPUP_USD must be at least {method.min_usd} for {coin} on {network}")
    if method.max_usd is not None and topup_usd > method.max_usd:
        raise ConfigError(f"TOPUP_USD must be at most {method.max_usd} for {coin} on {network}")
    return Config(**vars(settings), method=method)


def required(env: Env, name: str) -> str:
    value = env.get(name)
    if not value:
        raise ConfigError(f"{name} is required")
    return value


def whole_number(env: Env, name: str) -> int:
    text = required(env, name)
    if re.fullmatch(r"[0-9]+", text) is None:
        raise ConfigError(f"{name} must be a whole number of dollars")
    return int(text)


def positive_number(text: str) -> float | None:
    """The number in `text` if it is finite and above zero, otherwise None."""
    try:
        value = float(text) if "_" not in text else math.nan
    except ValueError:
        return None
    return value if math.isfinite(value) and value > 0 else None
