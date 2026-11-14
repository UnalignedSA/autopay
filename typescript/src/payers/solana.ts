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
import type { Payer } from '../autopay.ts';
import { toBaseUnits } from '../amounts.ts';
import { NATIVE_COIN } from '../config.ts';

const MINTS: Record<string, string> = {
	USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
	USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

const SOL_DECIMALS = 9;
const U64_MAX = 2n ** 64n - 1n;

/** Solana amounts are 64-bit: a larger one is refused, never cut down to fit. */
export function toU64(units: bigint): bigint {
	if (units > U64_MAX) throw new Error(`${units} base units do not fit in 64 bits`);
	return units;
}

/** The token program that owns a mint: classic or Token-2022. An account owned by anything else is no mint. */
export function tokenProgram(mintAddress: string, owner: PublicKey): PublicKey {
	if (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) return owner;
	throw new Error(`${mintAddress} is not a token mint (its owner is ${owner.toBase58()})`);
}

/** A base58 secret key, or the JSON byte array that solana-keygen writes. */
export function parseSolanaKey(text: string): Uint8Array {
	const trimmed = text.trim();
	let bytes: Uint8Array;
	try {
		bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
	} catch {
		throw new Error('SOLANA_PRIVATE_KEY is neither a base58 secret key nor a JSON byte array');
	}
	if (bytes.length !== 64) throw new Error('SOLANA_PRIVATE_KEY must hold a 64-byte secret key');
	return bytes;
}

export class SolanaPayer implements Payer {
	private readonly keypair: Keypair;
	private readonly connection: Connection;

	private readonly tokenAddress?: string;

	constructor(rpcUrl: string, privateKey: string, tokenAddress?: string) {
		this.tokenAddress = tokenAddress;
		this.keypair = Keypair.fromSecretKey(parseSolanaKey(privateKey));
		this.connection = new Connection(rpcUrl, 'confirmed');
	}

	/** The mint for a coin: undefined for SOL, a throw for an unknown token. */
	mintFor(coin: string): string | undefined {
		if (coin === NATIVE_COIN.solana) return undefined;
		const mint = this.tokenAddress ?? MINTS[coin];
		if (mint === undefined) throw new Error(`no token mint known for ${coin} on solana: set TOKEN_ADDRESS`);
		return mint;
	}

	address(): Promise<string> {
		return Promise.resolve(this.keypair.publicKey.toBase58());
	}

	async send(to: string, coin: string, amountCrypto: string): Promise<string> {
		const recipient = new PublicKey(to);
		const owner = this.keypair.publicKey;
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
			const info = await this.connection.getAccountInfo(mint);
			if (!info) throw new Error(`token mint ${mintAddress} not found`);
			const program = tokenProgram(mintAddress, info.owner);
			const mintInfo = await getMint(this.connection, mint, 'confirmed', program);
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
		return sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: 'confirmed' });
	}
}
