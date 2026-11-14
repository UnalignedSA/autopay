import { createPublicClient, createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { toBaseUnits } from '../amounts.js';
import { NATIVE_COIN } from '../config.js';

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
];

const TOKENS = {
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

/**
 * @typedef {object} EvmOptions
 * @property {string} rpcUrl
 * @property {string} privateKey
 * @property {string} network
 * @property {string} [tokenAddress] Overrides the built-in token contract.
 */

/** @implements {import('../autopay.js').Payer} */
export class EvmPayer {
	#account;
	#transport;
	#opts;

	/** @param {EvmOptions} opts */
	constructor(opts) {
		this.#opts = opts;
		const key = opts.privateKey.startsWith('0x') ? opts.privateKey : `0x${opts.privateKey}`;
		this.#account = privateKeyToAccount(/** @type {`0x${string}`} */ (key));
		this.#transport = http(opts.rpcUrl);
	}

	address() {
		return Promise.resolve(this.#account.address);
	}

	/**
	 * The token contract for a coin: undefined for the chain's native coin, a throw for an unknown token.
	 * @param {string} coin
	 */
	tokenFor(coin) {
		if (NATIVE_COIN[this.#opts.network] === coin) return undefined;
		const token = this.#opts.tokenAddress ?? TOKENS[this.#opts.network]?.[coin];
		if (token === undefined)
			throw new Error(`no token contract known for ${coin} on ${this.#opts.network}: set TOKEN_ADDRESS`);
		return token;
	}

	/** @param {string} to @param {string} coin @param {string} amountCrypto */
	async send(to, coin, amountCrypto) {
		const recipient = getAddress(to);
		const publicClient = createPublicClient({ transport: this.#transport });
		const chainId = await publicClient.getChainId();
		const chain = defineChain({
			id: chainId,
			name: this.#opts.network,
			nativeCurrency: { name: 'native', symbol: coin, decimals: NATIVE_DECIMALS },
			rpcUrls: { default: { http: [this.#opts.rpcUrl] } }
		});
		const wallet = createWalletClient({ account: this.#account, chain, transport: this.#transport });

		const token = this.tokenFor(coin);
		let hash;
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
