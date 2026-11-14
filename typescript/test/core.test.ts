import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, watchLoop, Fatal, type ApiLike, type Outcome, type Payer } from '../src/autopay.ts';
import { ApiError, type Deposit, type Invoice } from '../src/api.ts';
import type { Config } from '../src/config.ts';
import { StateError, StateStore, type State, type Topup } from '../src/state.ts';

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
	api.next = { ...invoice('inv-1'), amountUsd: 10, amountCrypto: '10.00' };
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

test('T9: DRY_RUN creates the payment but sends nothing and leaves the state file unchanged', async () => {
	store.save({ version: 1, topups: [record({ id: 'old', phase: 'done', result: 'paid' })] });
	const before = readFileSync(path, 'utf8');
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
	assert.equal(readFileSync(path, 'utf8'), before);
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

test('T14b: a 403 is fatal and explains the reseller case', async () => {
	api.balanceValue = new ApiError('forbidden', { status: 403, code: 'forbidden', transient: false });
	await assert.rejects(run(), (err: Error) => err instanceof Fatal && /reseller/.test(err.message));
});

test('a 429 is a retry', async () => {
	api.balanceValue = new ApiError('slow down', { status: 429, transient: true });
	assert.equal((await run()).type, 'retry');
});

test('a refunded invoice is done', async () => {
	store.save({ version: 1, topups: [record({ phase: 'sent', txid: '0xold', sentAt: NOW })] });
	api.statuses.set('inv-1', 'refunded');
	await run();
	assert.equal(topups()[0]?.phase, 'done');
	assert.equal(topups()[0]?.result, 'refunded');
});

test('a created invoice that is not waiting any more is not paid again', async () => {
	store.save({ version: 1, topups: [record({ phase: 'created' })] });
	api.statuses.set('inv-1', 'confirming');
	assert.equal((await run()).type, 'pending');
	assert.equal(payer.sent.length, 0);
});

test('the daily cap counts a hand-edited record that has no sentAt', async () => {
	store.save({
		version: 1,
		topups: [
			record({
				id: 'old',
				phase: 'done',
				result: 'paid',
				amountUsd: 45,
				txid: '0xold',
				createdAt: NOW - 2 * HOUR
			})
		]
	});
	assert.equal((await run(config({ topupUsd: 10, maxPerDayUsd: 50 }))).type, 'dailyCap');
	assert.ok(!api.calls.includes('create'));
});

test('an expired record that never sent anything does not count towards the cap', async () => {
	store.save({
		version: 1,
		topups: [
			record({ id: 'old', phase: 'done', result: 'expired', amountUsd: 45, createdAt: NOW - 2 * HOUR })
		]
	});
	api.next = { ...invoice('inv-1'), amountUsd: 10, amountCrypto: '10.00' };
	assert.equal((await run(config({ topupUsd: 10, maxPerDayUsd: 50 }))).type, 'sent');
});

test('an invoice that is not what was asked for is never paid', async () => {
	for (const wrong of [{ coin: 'USDC' }, { network: 'ethereum' }, { amountUsd: 5000 }]) {
		api.next = { ...invoice('inv-x'), ...wrong };
		await assert.rejects(run(), Fatal, JSON.stringify(wrong));
	}
	assert.equal(payer.sent.length, 0);
	assert.throws(() => readFileSync(path));
});

test('a deposit on the wrong network is never paid', async () => {
	const cfg = config({
		network: 'solana',
		method: { coin: 'USDT', network: 'solana', kind: 'deposit', min_usd: 1, max_usd: null }
	});
	api.next = { ...deposit(), coins: ['USDC'] };
	await assert.rejects(run(cfg), Fatal);
	assert.equal(payer.sent.length, 0);
});

test('a created invoice for another network or coin than the configuration is never paid', async () => {
	for (const other of [{ network: 'ethereum' }, { coin: 'USDC' }]) {
		store.save({ version: 1, topups: [record({ phase: 'created', ...other })] });
		await assert.rejects(run(), (err: Error) => err instanceof Fatal && /inv-1/.test(err.message));
	}
	assert.deepEqual(api.calls, []);
	assert.equal(payer.sent.length, 0);
	assert.equal(topups()[0]?.phase, 'created');
});

test('the transaction id is logged even when the save after the send fails', async () => {
	/** Fails to save the record once it is `sent`: the save after the send. */
	class FailingStore extends StateStore {
		override save(state: State): void {
			if (state.topups.some((t) => t.phase === 'sent')) throw new StateError('disk full');
			super.save(state);
		}
	}
	const failing = new FailingStore(path);
	const lines: string[] = [];
	await assert.rejects(
		step(
			config(),
			api,
			payer,
			failing,
			() => NOW,
			(l) => lines.push(l)
		),
		(err: Error) => err instanceof Fatal && /disk full/.test(err.message)
	);
	assert.equal(payer.sent.length, 1);
	assert.ok(lines.includes('sent 0xtxid'), lines.join('\n'));
});

test('a deposit still not credited 2 hours after the send needs a manual check', async () => {
	const cfg = config({
		network: 'solana',
		method: { coin: 'USDT', network: 'solana', kind: 'deposit', min_usd: 1, max_usd: null }
	});
	const sent = record({
		id: 'deposit:0xtxid',
		kind: 'deposit',
		network: 'solana',
		amountCrypto: '50',
		address: 'SoLaddress',
		expiresAt: null,
		phase: 'sent',
		txid: '0xtxid',
		sentAt: NOW - 2 * HOUR
	});
	store.save({ version: 1, topups: [sent] });
	assert.equal((await run(cfg)).type, 'pending');

	store.save({ version: 1, topups: [{ ...sent, sentAt: NOW - 2 * HOUR - 1 }] });
	const outcome = await run(cfg);
	assert.equal(outcome.type, 'manualCheck');
	assert.match(outcome.type === 'manualCheck' ? outcome.reason : '', /0xtxid.*2 hours/);
	assert.equal(topups()[0]?.phase, 'sent');

	// Credited late is still credited.
	api.deposits = [{ txHash: '0xtxid', credited: true }];
	assert.equal((await run(cfg)).type, 'idle');
	assert.equal(topups()[0]?.result, 'credited');
});

test('a state file with a malformed record is fatal', async () => {
	const good = record({});
	const bad: Record<string, unknown>[] = [
		{ ...good, phase: 'sendng' },
		{ ...good, network: 7 },
		{ ...good, txid: 5 },
		{ ...good, sentAt: '1793925000000' },
		{ ...good, expiresAt: 'soon' },
		{ ...good, coin: undefined }
	];
	for (const rec of bad) {
		writeFileSync(path, JSON.stringify({ version: 1, topups: [rec] }));
		await assert.rejects(run(), Fatal, JSON.stringify(rec));
	}
	assert.deepEqual(api.calls, []);
});

test('watch runs cycle after cycle, tolerates a retry, and stops on a manual check', async () => {
	const outcomes: Outcome[] = [
		{ type: 'idle' },
		{ type: 'retry', reason: 'x' },
		{ type: 'idle' },
		{ type: 'manualCheck', reason: 'y' }
	];
	let runs = 0;
	const sleeps: number[] = [];
	const code = await watchLoop(
		() => Promise.resolve(outcomes[runs++] as Outcome),
		(ms) => {
			sleeps.push(ms);
			return Promise.resolve();
		},
		() => 60,
		() => false
	);
	assert.equal(code, 3);
	assert.equal(runs, 4);
	assert.deepEqual(sleeps, [60_000, 60_000, 60_000]);
});

test('watch stops with 0 when asked to', async () => {
	let stop = false;
	let runs = 0;
	const code = await watchLoop(
		() => {
			runs++;
			return Promise.resolve({ type: 'idle' });
		},
		() => {
			stop = true;
			return Promise.resolve();
		},
		() => 60,
		() => stop
	);
	assert.equal(code, 0);
	assert.equal(runs, 1);
});

test('watch stops at once after a cycle during which a signal came', async () => {
	let stop = false;
	const sleeps: number[] = [];
	const code = await watchLoop(
		() => {
			stop = true;
			return Promise.resolve({ type: 'idle' });
		},
		(ms) => {
			sleeps.push(ms);
			return Promise.resolve();
		},
		() => 60,
		() => stop
	);
	assert.equal(code, 0);
	assert.deepEqual(sleeps, []);
});

test('watch lets a Fatal error through', async () => {
	await assert.rejects(
		watchLoop(
			() => Promise.reject(new Fatal('bad key')),
			() => Promise.resolve(),
			() => 60,
			() => false
		),
		Fatal
	);
});
