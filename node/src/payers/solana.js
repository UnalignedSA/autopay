import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
	getMint
} from '@solana/spl-token';
import {
	Connection,
	Keypair,
	PublicKey,
	sendAndConfirmTransaction,
	SystemProgram,
	Transaction
} from '@solana/web3.js';
import bs58 from 'bs58';

import { toBaseUnits } from '../amounts.js';
import { NATIVE_COIN } from '../config.js';

const MINTS = {
	USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
	USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

const SOL_DECIMALS = 9;

/**
 * A base58 secret key, or the JSON byte array that solana-keygen writes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function parseSolanaKey(text) {
	const trimmed = text.trim();
	let bytes;
	try {
		bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed);
	} catch {
		throw new Error('SOLANA_PRIVATE_KEY is neither a base58 secret key nor a JSON byte array');
	}
	if (bytes.length !== 64) throw new Error('SOLANA_PRIVATE_KEY must hold a 64-byte secret key');
	return bytes;
}

/** @implements {import('../autopay.js').Payer} */
export class SolanaPayer {
	#keypair;
	#connection;
	#tokenAddress;

	/** @param {string} rpcUrl @param {string} privateKey @param {string} [tokenAddress] */
	constructor(rpcUrl, privateKey, tokenAddress) {
		this.#tokenAddress = tokenAddress;
		this.#keypair = Keypair.fromSecretKey(parseSolanaKey(privateKey));
		this.#connection = new Connection(rpcUrl, 'confirmed');
	}

	/**
	 * The mint for a coin: undefined for SOL, a throw for an unknown token.
	 * @param {string} coin
	 */
	mintFor(coin) {
		if (coin === NATIVE_COIN.solana) return undefined;
		const mint = this.#tokenAddress ?? MINTS[coin];
		if (mint === undefined) throw new Error(`no token mint known for ${coin} on solana: set TOKEN_ADDRESS`);
		return mint;
	}

	address() {
		return Promise.resolve(this.#keypair.publicKey.toBase58());
	}

	/** @param {string} to @param {string} coin @param {string} amountCrypto */
	async send(to, coin, amountCrypto) {
		const recipient = new PublicKey(to);
		const owner = this.#keypair.publicKey;
		const tx = new Transaction();

		const mintAddress = this.mintFor(coin);
		if (mintAddress === undefined) {
			tx.add(
				SystemProgram.transfer({
					fromPubkey: owner,
					toPubkey: recipient,
					lamports: toBaseUnits(amountCrypto, SOL_DECIMALS)
				})
			);
		} else {
			const mint = new PublicKey(mintAddress);
			const info = await this.#connection.getAccountInfo(mint);
			if (!info) throw new Error(`token mint ${mintAddress} not found`);
			// The mint's owner is the token program (classic or Token-2022).
			const mintInfo = await getMint(this.#connection, mint, 'confirmed', info.owner);
			const from = getAssociatedTokenAddressSync(mint, owner, false, info.owner);
			const dest = getAssociatedTokenAddressSync(mint, recipient, true, info.owner);
			tx.add(
				createAssociatedTokenAccountIdempotentInstruction(owner, dest, recipient, mint, info.owner),
				createTransferCheckedInstruction(
					from,
					mint,
					dest,
					owner,
					toBaseUnits(amountCrypto, mintInfo.decimals),
					mintInfo.decimals,
					[],
					info.owner
				)
			);
		}
		return sendAndConfirmTransaction(this.#connection, tx, [this.#keypair], { commitment: 'confirmed' });
	}
}
