import asyncio
import json

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.models import TxOpts
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction
from spl.token.constants import TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID
from spl.token.instructions import (
    create_idempotent_associated_token_account,
    get_associated_token_address,
    transfer_checked,
)
from spl.token.models import TransferCheckedParams

from ..amounts import to_base_units
from ..config import NATIVE_COIN
from ..core import Payer

MINTS: dict[str, str] = {
    "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

SOL_DECIMALS = 9
BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def parse_solana_key(text: str) -> bytes:
    """A base58 secret key, or the JSON byte array that solana-keygen writes."""
    trimmed = text.strip()
    try:
        raw = bytes(json.loads(trimmed)) if trimmed.startswith("[") else b58decode(trimmed)
    except (ValueError, TypeError):
        raise ValueError("SOLANA_PRIVATE_KEY is neither a base58 secret key nor a JSON byte array") from None
    if len(raw) != 64:
        raise ValueError("SOLANA_PRIVATE_KEY must hold a 64-byte secret key")
    return raw


def b58decode(text: str) -> bytes:
    number = 0
    for char in text:
        number = number * 58 + BASE58.index(char)  # ValueError on a character outside the alphabet
    leading_zeros = len(text) - len(text.lstrip("1"))
    return b"\0" * leading_zeros + number.to_bytes((number.bit_length() + 7) // 8, "big")


class SolanaPayer(Payer):
    """A Solana wallet: SOL, or an SPL token with the recipient's token account created if needed."""

    def __init__(self, rpc_url: str, private_key: str, token_address: str | None = None) -> None:
        self._rpc_url = rpc_url
        self._token_address = token_address
        self._keypair = Keypair.from_bytes(parse_solana_key(private_key))

    def mint_for(self, coin: str) -> str | None:
        """The mint for a coin: None for SOL, an error for an unknown token."""
        if coin == NATIVE_COIN["solana"]:
            return None
        mint = self._token_address or MINTS.get(coin)
        if mint is None:
            raise RuntimeError(f"no token mint known for {coin} on solana: set TOKEN_ADDRESS")
        return mint

    def address(self) -> str:
        return str(self._keypair.pubkey())

    def send(self, to: str, coin: str, amount_crypto: str) -> str:
        return asyncio.run(self._send(to, coin, amount_crypto))

    async def _send(self, to: str, coin: str, amount_crypto: str) -> str:
        recipient = Pubkey.from_string(to)
        owner = self._keypair.pubkey()
        mint_address = self.mint_for(coin)

        async with AsyncClient(self._rpc_url, commitment=Confirmed) as client:
            if mint_address is None:
                instructions = [
                    transfer(
                        TransferParams(
                            from_pubkey=owner,
                            to_pubkey=recipient,
                            lamports=to_base_units(amount_crypto, SOL_DECIMALS),
                        )
                    )
                ]
            else:
                mint = Pubkey.from_string(mint_address)
                info = (await client.get_account_info(mint)).value
                if info is None:
                    raise RuntimeError(f"token mint {mint_address} not found")
                # The mint's owner is the token program (classic or Token-2022).
                program = info.owner
                if program not in (TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID):
                    raise RuntimeError(f"{mint_address} is not a token mint")
                decimals = (await client.get_token_supply(mint)).value.decimals
                source = get_associated_token_address(owner, mint, program)
                dest = get_associated_token_address(recipient, mint, program)
                instructions = [
                    create_idempotent_associated_token_account(owner, recipient, mint, program),
                    transfer_checked(
                        TransferCheckedParams(
                            program_id=program,
                            source=source,
                            mint=mint,
                            dest=dest,
                            owner=owner,
                            amount=to_base_units(amount_crypto, decimals),
                            decimals=decimals,
                        )
                    ),
                ]

            blockhash: Hash = (await client.get_latest_blockhash()).value.blockhash
            message = Message.new_with_blockhash(instructions, owner, blockhash)
            sent = await client.send_transaction(
                Transaction([self._keypair], message, blockhash), opts=TxOpts(preflight_commitment=Confirmed)
            )
            signature = sent.value
            confirmation = await client.confirm_transaction(signature, commitment=Confirmed)
            status = confirmation.value[0]
            if status is None or status.err is not None:
                raise RuntimeError(f"transaction {signature} failed: {status.err if status else 'not confirmed'}")
            return str(signature)
