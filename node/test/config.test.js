import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, preflight } from '../src/config.js';

const methods = [
	{ coin: 'USDT', network: 'bsc', kind: 'invoice', min_usd: 5, max_usd: 50000 },
	{ coin: 'USDT', network: 'solana', kind: 'deposit', min_usd: 1, max_usd: null },
	{ coin: 'BTC', network: 'bitcoin', kind: 'invoice', min_usd: 5, max_usd: 50000 }
];

const base = {
	UNALIGNED_KEY: 'key',
	NETWORK: 'bsc',
	COIN: 'USDT',
	THRESHOLD_USD: '10',
	TOPUP_USD: '50',
	MAX_PER_DAY_USD: '100',
	EVM_RPC_URL: 'http://localhost:8545',
	EVM_PRIVATE_KEY: '0x01'
};

test('reads a valid configuration and applies defaults', () => {
	const cfg = loadConfig(base, methods);
	assert.equal(cfg.network, 'bsc');
	assert.equal(cfg.coin, 'USDT');
	assert.equal(cfg.thresholdUsd, 10);
	assert.equal(cfg.topupUsd, 50);
	assert.equal(cfg.checkInterval, 60);
	assert.equal(cfg.dryRun, false);
	assert.equal(cfg.stateFile, './autopay-state.json');
	assert.equal(cfg.method.kind, 'invoice');
});

test('strips a trailing slash from UNALIGNED_API', () => {
	assert.equal(
		loadConfig({ ...base, UNALIGNED_API: 'https://example.test/v1/' }, methods).api,
		'https://example.test/v1'
	);
});

test('tron is not supported', () => {
	assert.throws(() => loadConfig({ ...base, NETWORK: 'tron' }, methods), /Tron is not supported/);
});

test('a pair that is not offered lists the valid pairs', () => {
	assert.throws(
		() => loadConfig({ ...base, COIN: 'DOGE' }, methods),
		(err) =>
			err instanceof ConfigError && err.message.includes('USDT/bsc') && err.message.includes('BTC/bitcoin')
	);
});

test('TOPUP_USD below the method minimum is rejected', () => {
	assert.throws(() => loadConfig({ ...base, TOPUP_USD: '3' }, methods), /TOPUP_USD/);
});

test('TOPUP_USD above the method maximum is rejected', () => {
	assert.throws(
		() => loadConfig({ ...base, TOPUP_USD: '60000', MAX_PER_DAY_USD: '70000' }, methods),
		/TOPUP_USD/
	);
});

test('TOPUP_USD must be a whole number', () => {
	assert.throws(() => loadConfig({ ...base, TOPUP_USD: '5.5' }, methods), /TOPUP_USD/);
});

test('MAX_PER_DAY_USD must cover one top-up', () => {
	assert.throws(() => loadConfig({ ...base, MAX_PER_DAY_USD: '40' }, methods), /MAX_PER_DAY_USD/);
});

test('THRESHOLD_USD must be above zero', () => {
	assert.throws(() => loadConfig({ ...base, THRESHOLD_USD: '0' }, methods), /THRESHOLD_USD/);
});

test('CHECK_INTERVAL below 15 seconds is rejected', () => {
	assert.throws(() => loadConfig({ ...base, CHECK_INTERVAL: '5' }, methods), /CHECK_INTERVAL/);
});

test('a missing wallet variable is named', () => {
	const { EVM_PRIVATE_KEY: _omitted, ...env } = base;
	assert.throws(() => loadConfig(env, methods), /EVM_PRIVATE_KEY/);
});

test('a missing key is named', () => {
	const { UNALIGNED_KEY: _omitted, ...env } = base;
	assert.throws(() => loadConfig(env, methods), /UNALIGNED_KEY/);
});

test('a deposit method has no maximum and needs the Solana wallet', () => {
	const env = { ...base, NETWORK: 'solana', TOPUP_USD: '1', MAX_PER_DAY_USD: '1000000' };
	assert.throws(() => loadConfig(env, methods), /SOLANA_RPC_URL/);
	const cfg = loadConfig({ ...env, SOLANA_RPC_URL: 'http://x', SOLANA_PRIVATE_KEY: 'k' }, methods);
	assert.equal(cfg.method.kind, 'deposit');
});

test('DRY_RUN=1 is read', () => {
	assert.equal(loadConfig({ ...base, DRY_RUN: '1' }, methods).dryRun, true);
});

test('preflight checks everything it can without the API', () => {
	assert.throws(() => preflight({ ...base, NETWORK: 'tron' }), /Tron/);
	assert.throws(() => preflight({ ...base, UNALIGNED_KEY: '' }), /UNALIGNED_KEY/);
	assert.throws(() => preflight({ ...base, EVM_RPC_URL: '' }), /EVM_RPC_URL/);
	assert.equal(preflight(base).topupUsd, 50);
});

test('TOKEN_ADDRESS with a native coin is rejected', () => {
	const env = {
		...base,
		NETWORK: 'ethereum',
		COIN: 'ETH',
		TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111'
	};
	assert.throws(() => preflight(env), /TOKEN_ADDRESS.*native coin/);
	assert.doesNotThrow(() =>
		preflight({ ...base, TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111' })
	);
});
