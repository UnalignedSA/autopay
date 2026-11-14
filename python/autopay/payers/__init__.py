"""One wallet per chain family."""

from collections.abc import Mapping

from ..config import WALLET_VARS, Config, ConfigError
from ..core import Payer
from .evm import EvmPayer
from .monero import MoneroPayer
from .solana import SolanaPayer
from .utxo import UtxoPayer


def make_payer(cfg: Config, env: Mapping[str, str]) -> Payer:
    """Builds the wallet for the configured network."""
    # The variables each network needs are listed once, in config.py.
    for name in WALLET_VARS.get(cfg.network, []):
        if not env.get(name):
            raise ConfigError(f"{name} is required")

    match cfg.network:
        case "ethereum" | "bsc":
            return EvmPayer(env["EVM_RPC_URL"], env["EVM_PRIVATE_KEY"], cfg.network, cfg.token_address)
        case "solana":
            return SolanaPayer(env["SOLANA_RPC_URL"], env["SOLANA_PRIVATE_KEY"], cfg.token_address)
        case "bitcoin" | "litecoin":
            return UtxoPayer(env["WALLET_RPC_URL"], env["WALLET_RPC_USER"], env["WALLET_RPC_PASSWORD"])
        case "monero":
            return MoneroPayer(
                env["MONERO_WALLET_RPC_URL"],
                env.get("MONERO_WALLET_RPC_USER", ""),
                env.get("MONERO_WALLET_RPC_PASSWORD", ""),
            )
        case "tron":
            raise ConfigError("Tron is not supported by this example yet")
        case _:
            raise ConfigError(f"no wallet for network {cfg.network}")
