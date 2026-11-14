import type { Method } from './api.ts';

export class ConfigError extends Error {}

export const DEFAULT_API = 'https://api.unaligned.pw/v1';

export interface Config {
	key: string;
	api: string;
	network: string;
	coin: string;
	method: Method;
	thresholdUsd: number;
	topupUsd: number;
	maxPerDayUsd: number;
	/** Seconds. */
	checkInterval: number;
	dryRun: boolean;
	refundAddress?: string;
	stateFile: string;
	tokenAddress?: string;
}

/** Config minus the payment method, which needs the API. */
export type Settings = Omit<Config, 'method'>;

type Env = Record<string, string | undefined>;

/** The wallet variables each network needs. */
const WALLET_VARS: Record<string, string[]> = {
	ethereum: ['EVM_RPC_URL', 'EVM_PRIVATE_KEY'],
	bsc: ['EVM_RPC_URL', 'EVM_PRIVATE_KEY'],
	solana: ['SOLANA_RPC_URL', 'SOLANA_PRIVATE_KEY'],
	bitcoin: ['WALLET_RPC_URL', 'WALLET_RPC_USER', 'WALLET_RPC_PASSWORD'],
	litecoin: ['WALLET_RPC_URL', 'WALLET_RPC_USER', 'WALLET_RPC_PASSWORD'],
	monero: ['MONERO_WALLET_RPC_URL']
};

/** The API base URL: UNALIGNED_API or the public default, without a trailing slash. */
export function apiBase(env: Env): string {
	return (env.UNALIGNED_API || DEFAULT_API).replace(/\/+$/, '');
}

/** Everything that can be checked without asking the API. Run it before any network call. */
export function preflight(env: Env): Settings {
	const key = required(env, 'UNALIGNED_KEY');
	const network = required(env, 'NETWORK').toLowerCase();
	const coin = required(env, 'COIN').toUpperCase();
	if (network === 'tron') throw new ConfigError('Tron is not supported by this example yet');

	const thresholdUsd = Number(required(env, 'THRESHOLD_USD'));
	if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
		throw new ConfigError('THRESHOLD_USD must be a number above 0');
	}
	const topupUsd = wholeNumber(env, 'TOPUP_USD');
	const maxPerDayUsd = wholeNumber(env, 'MAX_PER_DAY_USD');
	if (maxPerDayUsd < topupUsd) throw new ConfigError('MAX_PER_DAY_USD must be at least TOPUP_USD');

	const checkInterval = Number(env.CHECK_INTERVAL || '60');
	if (!Number.isInteger(checkInterval) || checkInterval < 15) {
		throw new ConfigError('CHECK_INTERVAL must be a whole number of seconds, at least 15');
	}

	for (const name of WALLET_VARS[network] ?? []) required(env, name);

	return {
		key,
		api: apiBase(env),
		network,
		coin,
		thresholdUsd,
		topupUsd,
		maxPerDayUsd,
		checkInterval,
		dryRun: env.DRY_RUN === '1',
		refundAddress: env.REFUND_ADDRESS || undefined,
		stateFile: env.STATE_FILE || './autopay-state.json',
		tokenAddress: env.TOKEN_ADDRESS || undefined
	};
}

/** Reads and validates the environment. `methods` is the answer of GET /payments/methods. */
export function loadConfig(env: Env, methods: Method[]): Config {
	const cfg = preflight(env);
	const { network, coin, topupUsd } = cfg;

	const method = methods.find((m) => m.network === network && m.coin === coin);
	if (!method) {
		const pairs = methods.map((m) => `${m.coin}/${m.network}`).join(', ');
		throw new ConfigError(`${coin} on ${network} is not offered. Valid COIN/NETWORK pairs: ${pairs}`);
	}
	if (topupUsd < method.min_usd) {
		throw new ConfigError(`TOPUP_USD must be at least ${method.min_usd} for ${coin} on ${network}`);
	}
	if (method.max_usd !== null && topupUsd > method.max_usd) {
		throw new ConfigError(`TOPUP_USD must be at most ${method.max_usd} for ${coin} on ${network}`);
	}
	return { ...cfg, method };
}

function required(env: Env, name: string): string {
	const value = env[name];
	if (!value) throw new ConfigError(`${name} is required`);
	return value;
}

function wholeNumber(env: Env, name: string): number {
	const text = required(env, name);
	if (!/^\d+$/.test(text)) throw new ConfigError(`${name} must be a whole number of dollars`);
	return Number(text);
}
