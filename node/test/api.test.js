import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Api, ApiError } from '../src/api.js';

let server;
let base;
let lastAuth;

/** What the API answers: snake_case, seconds. */
const invoice = {
	kind: 'invoice',
	id: 'inv-1',
	coin: 'USDT',
	network: 'bsc',
	amount_usd: 50,
	amount_crypto: '50.00',
	address: '0xa',
	created_at: 1793925000,
	expires_at: 1793926800,
	required_confirmations: 15,
	status: 'waiting',
	payments: []
};
const deposit = {
	kind: 'deposit',
	network: 'solana',
	coins: ['USDT', 'USDC'],
	address: 'A',
	min_usd: 1,
	required_confirmations: 1,
	deposits: [
		{ coin: 'USDT', amount: '5', usd: 5, tx_hash: 't1', at: 1793925000, confirmations: 3, credited: true },
		{ coin: 'USDT', amount: '5', usd: 5, tx_hash: 't2', at: 1793925060, confirmations: 0, credited: false }
	]
};

before(async () => {
	server = createServer((req, res) => {
		lastAuth = req.headers.authorization;
		const path = req.url ?? '';
		if (path.endsWith('/garbage')) {
			res.writeHead(200, { 'Content-Type': 'application/json' }).end('<html>');
		} else if (path.endsWith('/cut')) {
			// Promises more than it sends, then drops the connection.
			res.writeHead(200, { 'Content-Length': '100' });
			res.write('{"balance"');
			setTimeout(() => res.destroy(), 20);
		} else if (path.startsWith('/odd/')) {
			// A 2xx body that is not the documented answer.
			const bodies = {
				'/odd/empty/balance': '{}',
				'/odd/null/balance': 'null',
				'/odd/text/balance': '{"balance":"12.5"}',
				'/odd/infinite/balance': '{"balance":1e999}',
				'/odd/bare/payments/methods': '[]',
				'/odd/null/payments/methods': 'null',
				'/odd/empty/payments/methods': '{}',
				// The field names and milliseconds of the API before 2.0.
				'/odd/old/payments/inv-1': JSON.stringify({
					...invoice,
					amount_usd: undefined,
					amountUsd: 50,
					amountCrypto: '50.00',
					createdAt: 1793925000000,
					expiresAt: 1793926800000
				}),
				'/odd/text/payments/inv-1': JSON.stringify({ ...invoice, expires_at: '1793926800' }),
				// Without its expiry an invoice would be kept as one that never expires.
				'/odd/endless/payments/inv-1': JSON.stringify({ ...invoice, expires_at: undefined }),
				'/odd/fraction/payments/inv-1': JSON.stringify({ ...invoice, expires_at: 1.5 }),
				'/odd/zero/payments/inv-1': JSON.stringify({ ...invoice, expires_at: 0 }),
				'/odd/unborn/payments/inv-1': JSON.stringify({ ...invoice, created_at: 1793925000.5 }),
				'/odd/null/payments/inv-1': 'null'
			};
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(bodies[path] ?? '');
		} else if (path === '/balance') {
			res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"balance": 12.5}');
		} else if (path === '/payments/methods') {
			res
				.writeHead(200, { 'Content-Type': 'application/json' })
				.end(
					'{"methods":[{"coin":"USDT","network":"bsc","kind":"invoice","min_usd":5,"max_usd":null,"rate_usd":1,"confirmations":15}]}'
				);
		} else if (path === '/payments/inv-1' || path === '/payments') {
			res
				.writeHead(path === '/payments' ? 201 : 200, { 'Content-Type': 'application/json' })
				.end(JSON.stringify(invoice));
		} else if (path === '/payments/deposit/solana') {
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(deposit));
		} else if (path.endsWith('/full')) {
			res
				.writeHead(409, { 'Content-Type': 'application/json' })
				.end('{"error":{"code":"limit_reached","message":"too many open"}}');
		} else if (path.endsWith('/limited')) {
			res
				.writeHead(429, { 'Content-Type': 'application/json' })
				.end('{"error":{"code":"rate_limited","message":"slow"}}');
		} else {
			res
				.writeHead(400, { 'Content-Type': 'application/json', 'X-Request-Id': 'req_1' })
				.end('{"error":{"code":"invalid_request","message":"nope","request_id":"req_1"}}');
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('balance sends the key as a Bearer token', async () => {
	assert.equal(await new Api(base, 'secret').balance(), 12.5);
	assert.equal(lastAuth, 'Bearer secret');
});

test('methods is public: no Authorization header', async () => {
	const methods = await new Api(base, 'secret').methods();
	assert.equal(lastAuth, undefined);
	assert.deepEqual(
		methods.map((m) => [m.coin, m.network, m.kind, m.min_usd, m.max_usd]),
		[['USDT', 'bsc', 'invoice', 5, null]]
	);
});

test('an invoice is read from snake_case, its seconds become milliseconds', async () => {
	const expected = {
		kind: 'invoice',
		id: 'inv-1',
		coin: 'USDT',
		network: 'bsc',
		amountUsd: 50,
		amountCrypto: '50.00',
		address: '0xa',
		createdAt: 1793925000000,
		expiresAt: 1793926800000,
		status: 'waiting'
	};
	const api = new Api(base, 'k');
	assert.deepEqual(await api.getPayment('inv-1'), expected);
	assert.deepEqual(await api.createPayment({ amount_usd: 50, coin: 'USDT', network: 'bsc' }), expected);
});

test('a deposit address is read with its deposits by tx_hash', async () => {
	assert.deepEqual(await new Api(base, 'k').deposit('solana'), {
		kind: 'deposit',
		network: 'solana',
		coins: ['USDT', 'USDC'],
		address: 'A',
		deposits: [
			{ txHash: 't1', credited: true },
			{ txHash: 't2', credited: false }
		]
	});
});

test('a 2xx answer in another shape is a transient error, never a payment', async () => {
	for (const odd of ['old', 'text', 'null', 'endless', 'fraction', 'zero', 'unborn']) {
		await assert.rejects(
			new Api(`${base}/odd/${odd}`, 'k').getPayment('inv-1'),
			(err) => err instanceof ApiError && err.transient && /unexpected response/.test(err.message),
			odd
		);
	}
	for (const odd of ['bare', 'null', 'empty']) {
		await assert.rejects(
			new Api(`${base}/odd/${odd}`, 'k').methods(),
			(err) => err instanceof ApiError && err.transient,
			odd
		);
	}
});

test('a 400 carries the API error code and the request id, and is not transient', async () => {
	await assert.rejects(new Api(base, 'k').deposit('x'), (err) => {
		return (
			err instanceof ApiError &&
			err.status === 400 &&
			err.code === 'invalid_request' &&
			!err.transient &&
			err.message === 'GET /payments/deposit/x: 400 invalid_request nope (request req_1)'
		);
	});
});

test('a 409 (too many open invoices) is not transient', async () => {
	await assert.rejects(
		new Api(base, 'k').getPayment('full'),
		(err) => err.status === 409 && err.code === 'limit_reached' && !err.transient
	);
});

test('a 429 is transient', async () => {
	await assert.rejects(
		new Api(base, 'k').getPayment('limited'),
		(err) => err.status === 429 && err.transient
	);
});

test('a non-JSON or cut-off 200 body is a transient error', async () => {
	for (const id of ['garbage', 'cut']) {
		await assert.rejects(
			new Api(base, 'k').getPayment(id),
			(err) => err instanceof ApiError && err.transient,
			id
		);
	}
});

test('a 2xx /balance without a finite number is a transient error, never a balance', async () => {
	for (const odd of ['empty', 'null', 'text', 'infinite']) {
		await assert.rejects(
			new Api(`${base}/odd/${odd}`, 'k').balance(),
			(err) => err instanceof ApiError && err.transient,
			odd
		);
	}
});

test('a refused connection is a transient error', async () => {
	await assert.rejects(
		new Api('http://127.0.0.1:1', 'k').balance(),
		(err) => err instanceof ApiError && err.transient
	);
});
