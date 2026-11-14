import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, Fatal, type ApiLike, type Payer } from '../src/autopay.ts';
import { ApiError, type Deposit, type Invoice } from '../src/api.ts';
import type { Config } from '../src/config.ts';
import { StateStore, type Topup } from '../src/state.ts';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class FakeApi implements ApiLike {
	calls: string[] = [];
	created: Record<string, unknown>[] = [];
	balanceValue: number | ApiError = 3;
	statuses = new Map<string, string>();
	next: Invoice | Deposit = invoice('inv-1');
	deposits: Deposit['deposits'] = [];

	balance(): Promise<number> {
		this.calls.push('balance');
		return this.balanceValue instanceof ApiError
			? Promise.reject(this.balanceValue)
			: Promise.resolve(this.balanceValue);
	}
	createPayment(body: Record<string, unknown>): Promise<Invoice | Deposit> {
		this.calls.push('create');
		this.created.push(body);
		return Promise.resolve(this.next);
	}
	getPayment(id: string): Promise<Invoice> {
		this.calls.push(`get ${id}`);
		return Promise.resolve({ ...invoice(id), status: this.statuses.get(id) ?? 'waiting' });
	}
	deposit(network: string): Promise<Deposit> {
		this.calls.push(`deposit ${network}`);
		return Promise.resolve({ ...deposit(), deposits: this.deposits });
	}
}

class FakePayer implements Payer {
	sent: { to: string; coin: string; amount: string }[] = [];
	failWith: Error | null = null;
	address(): Promise<string> {
		return Promise.resolve('0xwallet');
	}
	send(to: string, coin: string, amount: string): Promise<string> {
		if (this.failWith) return Promise.reject(this.failWith);
		this.sent.push({ to, coin, amount });
		return Promise.resolve('0xtxid');
	}
}

function invoice(id: string): Invoice {
	return {
		kind: 'invoice',
		id,
		coin: 'USDT',
		network: 'bsc',
		amountUsd: 50,
		amountCrypto: '50.00',
		address: '0xinvoice',
		createdAt: NOW,
		expiresAt: NOW + 30 * MINUTE,
		status: 'waiting'
	};
}

function deposit(): Deposit {
	return { kind: 'deposit', network: 'solana', coins: ['USDT', 'USDC'], address: 'SoLaddress', deposits: [] };
}

function record(over: Partial<Topup>): Topup {
	return {
		id: 'inv-1',
		kind: 'invoice',
		network: 'bsc',
		coin: 'USDT',
		amountUsd: 50,
		amountCrypto: '50.00',
		address: '0xinvoice',
		expiresAt: NOW + 30 * MINUTE,
		phase: 'created',
		txid: null,
		createdAt: NOW,
		sentAt: null,
		result: null,
		...over
	};
}

let dir: string;
let path: string;
let store: StateStore;
let api: FakeApi;
let payer: FakePayer;

function config(over: Partial<Config> = {}): Config {
	return {
		key: 'key',
		api: 'https://example.test/v1',
		network: 'bsc',
		coin: 'USDT',
		method: { coin: 'USDT', network: 'bsc', kind: 'invoice', min_usd: 5, max_usd: 50000 },
		thresholdUsd: 10,
		topupUsd: 50,
		maxPerDayUsd: 100,
		checkInterval: 60,
		dryRun: false,
		stateFile: path,
		...over
	};
}

const run = (cfg = config(), at = NOW) =>
	step(
		cfg,
		api,
		payer,
		store,
		() => at,
		() => {}
	);
const topups = () => store.load().topups;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'autopay-'));
	path = join(dir, 'state.json');
	store = new StateStore(path);
	api = new FakeApi();
	payer = new FakePayer();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('T1: balance above the threshold does nothing', async () => {
	api.balanceValue = 20;
	assert.equal((await run()).type, 'idle');
	assert.deepEqual(api.calls, ['balance']);
	assert.equal(payer.sent.length, 0);
});

test('T2: low balance creates an invoice and sends the exact amount', async () => {
	assert.equal((await run()).type, 'sent');
	assert.deepEqual(api.created, [{ amount_usd: 50, coin: 'USDT', network: 'bsc' }]);
	assert.deepEqual(payer.sent, [{ to: '0xinvoice', coin: 'USDT', amount: '50.00' }]);
	const [rec] = topups();
	assert.equal(rec?.phase, 'sent');
	assert.equal(rec?.txid, '0xtxid');
	assert.equal(rec?.sentAt, NOW);
});

test('T2b: the refund address is passed when configured', async () => {
	await run(config({ refundAddress: '0xrefund' }));
	assert.deepEqual(api.created, [
		{ amount_usd: 50, coin: 'USDT', network: 'bsc', refund_address: '0xrefund' }
	]);
});

test('T3: a record in sending needs a manual check', async () => {
	store.save({ version: 1, topups: [record({ phase: 'sending' })] });
	const outcome = await run();
	assert.equal(outcome.type, 'manualCheck');
	assert.deepEqual(api.calls, []);
	assert.equal(payer.sent.length, 0);
});

test('T4: a paid invoice is done, and the next cycle tops up again', async () => {
	store.save({ version: 1, topups: [record({ phase: 'sent', txid: '0xold', sentAt: NOW - 3 * HOUR })] });
	api.statuses.set('inv-1', 'paid');
	await run();
	assert.equal(topups()[0]?.phase, 'done');
	assert.equal(topups()[0]?.result, 'paid');
	api.next = invoice('inv-2');
	assert.equal((await run()).type, 'sent');
	assert.equal(topups().length, 2);
});

test('T4b: a sent invoice still confirming stays pending', async () => {
	store.save({ version: 1, topups: [record({ phase: 'sent', txid: '0xold', sentAt: NOW })] });
	api.statuses.set('inv-1', 'confirming');
	assert.equal((await run()).type, 'pending');
	assert.equal(topups()[0]?.phase, 'sent');
});

test('T5: a sent invoice that expired needs a manual check', async () => {
	store.save({ version: 1, topups: [record({ phase: 'sent', txid: '0xold', sentAt: NOW })] });
	api.statuses.set('inv-1', 'expired');
	assert.equal((await run()).type, 'manualCheck');
	assert.ok(!api.calls.includes('create'));
});

test('T6: a created invoice that expired is closed without sending', async () => {
	store.save({ version: 1, topups: [record({ phase: 'created' })] });
	api.statuses.set('inv-1', 'expired');
	await run();
	assert.equal(topups()[0]?.phase, 'done');
	assert.equal(topups()[0]?.result, 'expired');
	assert.equal(payer.sent.length, 0);
	assert.ok(!api.calls.includes('create'));
});

test('T6b: a created invoice that is still open is sent after a restart', async () => {
	store.save({ version: 1, topups: [record({ phase: 'created' })] });
	assert.equal((await run()).type, 'sent');
	assert.equal(payer.sent.length, 1);
	assert.ok(!api.calls.includes('create'));
});

test('T7: the daily cap stops a top-up that would exceed it', async () => {
	store.save({
		version: 1,
		topups: [record({ id: 'old', phase: 'done', result: 'paid', amountUsd: 45, sentAt: NOW - 2 * HOUR })]
	});
	const outcome = await run(config({ topupUsd: 10, maxPerDayUsd: 50 }));
	assert.equal(outcome.type, 'dailyCap');
	assert.ok(!api.calls.includes('create'));
});

test('T7b: sends older than 24 hours do not count', async () => {
	store.save({
		version: 1,
		topups: [record({ id: 'old', phase: 'done', result: 'paid', amountUsd: 45, sentAt: NOW - 25 * HOUR })]
	});
	assert.equal((await run(config({ topupUsd: 10, maxPerDayUsd: 50 }))).type, 'sent');
});

test('T8: a deposit method sends the amount 1:1 and waits for the credit', async () => {
	const cfg = config({
		network: 'solana',
		method: { coin: 'USDT', network: 'solana', kind: 'deposit', min_usd: 1, max_usd: null },
		topupUsd: 10
	});
	api.next = deposit();
	assert.equal((await run(cfg)).type, 'sent');
	assert.deepEqual(api.created, [{ coin: 'USDT', network: 'solana' }]);
	assert.deepEqual(payer.sent, [{ to: 'SoLaddress', coin: 'USDT', amount: '10' }]);
	assert.equal(topups()[0]?.id, 'deposit:0xtxid');
	assert.equal(topups()[0]?.kind, 'deposit');

	api.deposits = [{ txHash: '0xtxid', credited: false }];
	assert.equal((await run(cfg)).type, 'pending');
	api.deposits = [{ txHash: '0xtxid', credited: true }];
	await run(cfg);
	assert.equal(topups()[0]?.phase, 'done');
	assert.equal(topups()[0]?.result, 'credited');
});

test('T9: DRY_RUN creates the payment but sends nothing and writes no state', async () => {
	const lines: string[] = [];
	const outcome = await step(
		config({ dryRun: true }),
		api,
		payer,
		store,
		() => NOW,
		(l) => lines.push(l)
	);
	assert.equal(outcome.type, 'idle');
	assert.equal(api.created.length, 1);
	assert.equal(payer.sent.length, 0);
	assert.throws(() => readFileSync(path));
	assert.ok(lines.includes('would send 50.00 USDT on bsc to 0xinvoice'));
});

test('T10: a failing send leaves the record in sending and asks for a manual check', async () => {
	payer.failWith = new Error('rpc down');
	const outcome = await run();
	assert.equal(outcome.type, 'manualCheck');
	assert.equal(topups()[0]?.phase, 'sending');
	payer.failWith = null;
	assert.equal((await run()).type, 'manualCheck');
	assert.equal(payer.sent.length, 0);
});

test('T11: a corrupt state file is fatal and calls nothing', async () => {
	writeFileSync(path, '{not json');
	await assert.rejects(run(), Fatal);
	assert.deepEqual(api.calls, []);
});

test('T12: an invoice about to expire is not paid', async () => {
	store.save({ version: 1, topups: [record({ phase: 'created', expiresAt: NOW + 4 * MINUTE })] });
	assert.equal((await run()).type, 'pending');
	assert.equal(payer.sent.length, 0);
});

test('T13: a 503 is a retry, not a failure', async () => {
	api.balanceValue = new ApiError('unavailable', { status: 503, transient: true });
	assert.equal((await run()).type, 'retry');
});

test('T14: a 401 is fatal', async () => {
	api.balanceValue = new ApiError('unauthorized', { status: 401, code: 'unauthorized', transient: false });
	await assert.rejects(run(), Fatal);
});
