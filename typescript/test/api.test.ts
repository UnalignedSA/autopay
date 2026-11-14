import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Api, ApiError } from '../src/api.ts';

let server: Server;
let base: string;
let lastAuth: string | undefined;

before(async () => {
	server = createServer((req: IncomingMessage, res) => {
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
			// A 2xx body without a usable balance.
			const bodies: Record<string, string> = {
				'/odd/empty/balance': '{}',
				'/odd/null/balance': 'null',
				'/odd/text/balance': '{"balance":"12.5"}',
				'/odd/infinite/balance': '{"balance":1e999}'
			};
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(bodies[path] ?? '');
		} else if (path === '/balance') {
			res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"balance": 12.5}');
		} else if (path === '/payments/methods') {
			res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
		} else if (path.endsWith('/limited')) {
			res
				.writeHead(429, { 'Content-Type': 'application/json' })
				.end('{"error":{"code":"rate_limited","message":"slow"}}');
		} else {
			res
				.writeHead(400, { 'Content-Type': 'application/json' })
				.end('{"error":{"code":"invalid_input","message":"nope"}}');
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('balance sends the key as a Bearer token', async () => {
	assert.equal(await new Api(base, 'secret').balance(), 12.5);
	assert.equal(lastAuth, 'Bearer secret');
});

test('methods is public: no Authorization header', async () => {
	await new Api(base, 'secret').methods();
	assert.equal(lastAuth, undefined);
});

test('a 400 carries the API error code and is not transient', async () => {
	await assert.rejects(new Api(base, 'k').deposit('x'), (err: ApiError) => {
		return (
			err instanceof ApiError &&
			err.status === 400 &&
			err.code === 'invalid_input' &&
			!err.transient &&
			/nope/.test(err.message)
		);
	});
});

test('a 429 is transient', async () => {
	await assert.rejects(
		new Api(base, 'k').getPayment('limited'),
		(err: ApiError) => err.status === 429 && err.transient
	);
});

test('a non-JSON or cut-off 200 body is a transient error', async () => {
	for (const id of ['garbage', 'cut']) {
		await assert.rejects(
			new Api(base, 'k').getPayment(id),
			(err: ApiError) => err instanceof ApiError && err.transient,
			id
		);
	}
});

test('a 2xx /balance without a finite number is a transient error, never a balance', async () => {
	for (const odd of ['empty', 'null', 'text', 'infinite']) {
		await assert.rejects(
			new Api(`${base}/odd/${odd}`, 'k').balance(),
			(err: ApiError) => err instanceof ApiError && err.transient,
			odd
		);
	}
});

test('a refused connection is a transient error', async () => {
	await assert.rejects(
		new Api('http://127.0.0.1:1', 'k').balance(),
		(err: ApiError) => err instanceof ApiError && err.transient
	);
});
