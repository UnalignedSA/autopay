import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
	getMint,
	TOKEN_2022_PROGRAM_ID,
	TOKEN_PROGRAM_ID
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
const U64_MAX = 2n ** 64n - 1n;

/**
 * Solana amounts are 64-bit: a larger one is refused, never cut down to fit.
 * @param {bigint} units
 */
export function toU64(units) {
	if (units > U64_MAX) throw new Error(`${units} base units do not fit in 64 bits`);
	return units;
}

/**
 * The token program that owns a mint: classic or Token-2022. An account owned by anything else is no mint.
 * @param {string} mintAddress
 * @param {PublicKey} owner
 */
export function tokenProgram(mintAddress, owner) {
	if (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) return owner;
	throw new Error(`${mintAddress} is not a token mint (its owner is ${owner.toBase58()})`);
}

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
					lamports: toU64(toBaseUnits(amountCrypto, SOL_DECIMALS))
				})
			);
		} else {
			const mint = new PublicKey(mintAddress);
			const info = await this.#connection.getAccountInfo(mint);
			if (!info) throw new Error(`token mint ${mintAddress} not found`);
			const program = tokenProgram(mintAddress, info.owner);
			const mintInfo = await getMint(this.#connection, mint, 'confirmed', program);
			if (!mintInfo.isInitialized) throw new Error(`token mint ${mintAddress} is not initialized`);
			const from = getAssociatedTokenAddressSync(mint, owner, false, program);
			const dest = getAssociatedTokenAddressSync(mint, recipient, true, program);
			tx.add(
				createAssociatedTokenAccountIdempotentInstruction(owner, dest, recipient, mint, program),
				createTransferCheckedInstruction(
					from,
					mint,
					dest,
					owner,
					toU64(toBaseUnits(amountCrypto, mintInfo.decimals)),
					mintInfo.decimals,
					[],
					program
				)
			);
		}
		return sendAndConfirmTransaction(this.#connection, tx, [this.#keypair], { commitment: 'confirmed' });
	}
}
