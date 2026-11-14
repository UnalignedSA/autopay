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
import type { Payer } from '../autopay.ts';
import { toBaseUnits } from '../amounts.ts';
import { NATIVE_COIN } from '../config.ts';

const MINTS: Record<string, string> = {
	USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
	USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

const SOL_DECIMALS = 9;

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
					lamports: toBaseUnits(amountCrypto, SOL_DECIMALS)
				})
			);
		} else {
			const mint = new PublicKey(mintAddress);
			const info = await this.connection.getAccountInfo(mint);
			if (!info) throw new Error(`token mint ${mintAddress} not found`);
			// The mint's owner is the token program (classic or Token-2022).
			const mintInfo = await getMint(this.connection, mint, 'confirmed', info.owner);
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
		return sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: 'confirmed' });
	}
}
