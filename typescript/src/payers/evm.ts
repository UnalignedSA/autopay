import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Payer } from '../autopay.ts';
import { toBaseUnits } from '../amounts.ts';

/**
 * `transfer` declares no outputs on purpose: Ethereum USDT returns nothing, and viem would fail to decode a
 * missing bool. Success is the receipt status instead.
 */
export const ERC20_ABI = [
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' }
		],
		outputs: []
	},
	{
		type: 'function',
		name: 'decimals',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint8' }]
	}
] as const;

const TOKENS: Record<string, Record<string, string>> = {
	ethereum: {
		USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
		USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
	},
	bsc: {
		USDT: '0x55d398326f99059fF775485246999027B3197955',
		USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
	}
};

const NATIVE_DECIMALS = 18;

export interface EvmOptions {
	rpcUrl: string;
	privateKey: string;
	network: string;
	/** Overrides the built-in token contract. */
	tokenAddress?: string;
}

export class EvmPayer implements Payer {
	private readonly account;
	private readonly transport;

	private readonly opts: EvmOptions;

	constructor(opts: EvmOptions) {
		this.opts = opts;
		const key = opts.privateKey.startsWith('0x') ? opts.privateKey : `0x${opts.privateKey}`;
		this.account = privateKeyToAccount(key as Hex);
		this.transport = http(opts.rpcUrl);
	}

	address(): Promise<string> {
		return Promise.resolve(this.account.address);
	}

	/** The token contract for a coin, or undefined for the chain's native coin. */
	tokenFor(coin: string): string | undefined {
		return this.opts.tokenAddress ?? TOKENS[this.opts.network]?.[coin];
	}

	async send(to: string, coin: string, amountCrypto: string): Promise<string> {
		const recipient = getAddress(to);
		const publicClient = createPublicClient({ transport: this.transport });
		const chainId = await publicClient.getChainId();
		const chain = defineChain({
			id: chainId,
			name: this.opts.network,
			nativeCurrency: { name: 'native', symbol: coin, decimals: NATIVE_DECIMALS },
			rpcUrls: { default: { http: [this.opts.rpcUrl] } }
		});
		const wallet = createWalletClient({ account: this.account, chain, transport: this.transport });

		const token = this.tokenFor(coin);
		let hash: Hex;
		if (token === undefined) {
			hash = await wallet.sendTransaction({
				to: recipient,
				value: toBaseUnits(amountCrypto, NATIVE_DECIMALS)
			});
		} else {
			const address = getAddress(token);
			const decimals = await publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' });
			hash = await wallet.writeContract({
				address,
				abi: ERC20_ABI,
				functionName: 'transfer',
				args: [recipient, toBaseUnits(amountCrypto, decimals)]
			});
		}
		const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
		if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
		return hash;
	}
}
