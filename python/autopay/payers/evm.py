from typing import Any

from eth_account import Account
from web3 import Web3

from ..amounts import to_base_units
from ..config import NATIVE_COIN, ConfigError
from ..core import Payer

#: `transfer` declares no outputs on purpose: Ethereum USDT returns nothing, and decoding a missing bool
#: would fail. Success is the receipt status instead.
ERC20_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "transfer",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "decimals",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
]

TOKENS: dict[str, dict[str, str]] = {
    "ethereum": {
        "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    "bsc": {
        "USDT": "0x55d398326f99059fF775485246999027B3197955",
        "USDC": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    },
}

NATIVE_DECIMALS = 18
RECEIPT_TIMEOUT_SECONDS = 300

#: The chain id of each mainnet.
MAINNET_CHAIN_ID = {"ethereum": 1, "bsc": 56}


def check_chain_id(network: str, chain_id: int) -> None:
    """Refuses a node of the other mainnet: chain id 1 when NETWORK is bsc, 56 when it is ethereum.

    A payment signed there would go out on the wrong chain. Any other chain id is allowed, so test chains
    still work.
    """
    for other, other_id in MAINNET_CHAIN_ID.items():
        if other != network and other_id == chain_id:
            raise ConfigError(f"EVM_RPC_URL is a {other} node (chain id {chain_id}), but NETWORK is {network}")


class EvmPayer(Payer):
    """An Ethereum-compatible wallet: the native coin or an ERC-20 token."""

    def __init__(self, rpc_url: str, private_key: str, network: str, token_address: str | None = None) -> None:
        self._rpc_url = rpc_url
        self._network = network
        # Overrides the built-in token contract.
        self._token_address = token_address
        self._account = Account.from_key(private_key if private_key.startswith("0x") else f"0x{private_key}")

    def address(self) -> str:
        return self._account.address

    def check(self) -> None:
        """Reads the node's chain id once at start, so a wrong node is refused before any payment is created."""
        check_chain_id(self._network, Web3(Web3.HTTPProvider(self._rpc_url)).eth.chain_id)

    def token_for(self, coin: str) -> str | None:
        """The token contract for a coin: None for the chain's native coin, an error for an unknown token."""
        if NATIVE_COIN.get(self._network) == coin:
            return None
        token = self._token_address or TOKENS.get(self._network, {}).get(coin)
        if token is None:
            raise RuntimeError(f"no token contract known for {coin} on {self._network}: set TOKEN_ADDRESS")
        return token

    def send(self, to: str, coin: str, amount_crypto: str) -> str:
        w3 = Web3(Web3.HTTPProvider(self._rpc_url))
        recipient = Web3.to_checksum_address(to)
        token = self.token_for(coin)
        # Checked again here: nothing is signed for the wrong chain, even if the node changed since the start.
        chain_id = w3.eth.chain_id
        check_chain_id(self._network, chain_id)
        tx: dict[str, Any] = {
            "from": self._account.address,
            "nonce": w3.eth.get_transaction_count(self._account.address),
            "chainId": chain_id,
            "gasPrice": w3.eth.gas_price,
        }
        if token is None:
            tx |= {"to": recipient, "value": to_base_units(amount_crypto, NATIVE_DECIMALS)}
            tx["gas"] = w3.eth.estimate_gas(tx)
        else:
            contract = w3.eth.contract(address=Web3.to_checksum_address(token), abi=ERC20_ABI)
            decimals = contract.functions.decimals().call()
            tx = contract.functions.transfer(recipient, to_base_units(amount_crypto, decimals)).build_transaction(tx)

        signed = self._account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=RECEIPT_TIMEOUT_SECONDS)
        if receipt["status"] != 1:
            raise RuntimeError(f"transaction {tx_hash.to_0x_hex()} reverted")
        return tx_hash.to_0x_hex()
