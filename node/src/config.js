export class ConfigError extends Error {}

export const DEFAULT_API = 'https://api.unaligned.pw/v1';

/**
 * Everything the program needs, except the payment method (which needs the API).
 * @typedef {object} Settings
 * @property {string} key
 * @property {string} api
 * @property {string} network
 * @property {string} coin
 * @property {number} thresholdUsd
 * @property {number} topupUsd
 * @property {number} maxPerDayUsd
 * @property {number} checkInterval seconds
 * @property {boolean} dryRun
 * @property {string} [refundAddress]
 * @property {string} stateFile
 * @property {string} [tokenAddress]
 */

/**
 * @typedef {Settings & { method: import('./api.js').Method }} Config
 */

/** @typedef {Record<string, string | undefined>} Env */

/**
 * The wallet variables each network needs.
 * @type {Record<string, string[]>}
 */
export const WALLET_VARS = {
	ethereum: ['EVM_RPC_URL', 'EVM_PRIVATE_KEY'],
	bsc: ['EVM_RPC_URL', 'EVM_PRIVATE_KEY'],
	solana: ['SOLANA_RPC_URL', 'SOLANA_PRIVATE_KEY'],
	bitcoin: ['WALLET_RPC_URL', 'WALLET_RPC_USER', 'WALLET_RPC_PASSWORD'],
	litecoin: ['WALLET_RPC_URL', 'WALLET_RPC_USER', 'WALLET_RPC_PASSWORD'],
	monero: ['MONERO_WALLET_RPC_URL']
};

/**
 * The coin each network's own currency is called. Every other coin is a token.
 * @type {Record<string, string>}
 */
export const NATIVE_COIN = {
	ethereum: 'ETH',
	bsc: 'BNB',
	solana: 'SOL',
	bitcoin: 'BTC',
	litecoin: 'LTC',
	monero: 'XMR'
};

/** The API base URL: UNALIGNED_API or the public default, without a trailing slash. */
/** @param {Env} env */
export function apiBase(env) {
	return (env.UNALIGNED_API || DEFAULT_API).replace(/\/+$/, '');
}

/** Everything that can be checked without asking the API. Run it before any network call. */
/**
 * @param {Env} env
 * @returns {Settings}
 */
export function preflight(env) {
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

	if (env.TOKEN_ADDRESS && NATIVE_COIN[network] === coin) {
		throw new ConfigError(
			`TOKEN_ADDRESS is for tokens: ${coin} is the native coin of ${network}, unset TOKEN_ADDRESS`
		);
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

/**
 * Reads and validates the environment. `methods` is the answer of GET /payments/methods.
 * @param {Env} env
 * @param {import('./api.js').Method[]} methods
 * @returns {Config}
 */
export function loadConfig(env, methods) {
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

/** @param {Env} env @param {string} name */
function required(env, name) {
	const value = env[name];
	if (!value) throw new ConfigError(`${name} is required`);
	return value;
}

/** @param {Env} env @param {string} name */
function wholeNumber(env, name) {
	const text = required(env, name);
	if (!/^\d+$/.test(text)) throw new ConfigError(`${name} must be a whole number of dollars`);
	return Number(text);
}
