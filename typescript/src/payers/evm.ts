import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Payer } from '../autopay.ts';
import { toBaseUnits } from '../amounts.ts';
import { ConfigError, NATIVE_COIN } from '../config.ts';

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

/** The chain id of each mainnet. */
const MAINNET_CHAIN_ID: Record<string, number> = { ethereum: 1, bsc: 56 };

/**
 * Refuses a node of the other mainnet: chain id 1 when NETWORK is bsc, 56 when it is ethereum. A payment
 * signed there would go out on the wrong chain. Any other chain id is allowed, so test chains still work.
 */
export function checkChainId(network: string, chainId: number): void {
	for (const [other, id] of Object.entries(MAINNET_CHAIN_ID)) {
		if (other !== network && id === chainId) {
			throw new ConfigError(
				`EVM_RPC_URL is a ${other} node (chain id ${chainId}), but NETWORK is ${network}`
			);
		}
	}
}

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
	private readonly client;

	private readonly opts: EvmOptions;

	constructor(opts: EvmOptions) {
		this.opts = opts;
		const key = opts.privateKey.startsWith('0x') ? opts.privateKey : `0x${opts.privateKey}`;
		this.account = privateKeyToAccount(key as Hex);
		this.transport = http(opts.rpcUrl);
		this.client = createPublicClient({ transport: this.transport });
	}

	/** Reads the node's chain id once at start, so a wrong node is refused before any payment is created. */
	async check(): Promise<void> {
		checkChainId(this.opts.network, await this.client.getChainId());
	}

	address(): Promise<string> {
		return Promise.resolve(this.account.address);
	}

	/** The token contract for a coin: undefined for the chain's native coin, a throw for an unknown token. */
	tokenFor(coin: string): string | undefined {
		if (NATIVE_COIN[this.opts.network] === coin) return undefined;
		const token = this.opts.tokenAddress ?? TOKENS[this.opts.network]?.[coin];
		if (token === undefined)
			throw new Error(`no token contract known for ${coin} on ${this.opts.network}: set TOKEN_ADDRESS`);
		return token;
	}

	async send(to: string, coin: string, amountCrypto: string): Promise<string> {
		const recipient = getAddress(to);
		// Checked again here: nothing is signed for the wrong chain, even if the node changed since the start.
		const chainId = await this.client.getChainId();
		checkChainId(this.opts.network, chainId);
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
			const decimals = await this.client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' });
			hash = await wallet.writeContract({
				address,
				abi: ERC20_ABI,
				functionName: 'transfer',
				args: [recipient, toBaseUnits(amountCrypto, decimals)]
			});
		}
		const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: 1 });
		if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
		return hash;
	}
}
