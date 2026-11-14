import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkChainId, ERC20_ABI, EvmPayer } from '../src/payers/evm.ts';
import { UtxoPayer } from '../src/payers/utxo.ts';
import { MoneroPayer } from '../src/payers/monero.ts';
import { parseSolanaKey, SolanaPayer, tokenProgram, toU64 } from '../src/payers/solana.ts';
import { ConfigError } from '../src/config.ts';
import { makePayer } from '../src/payers/index.ts';
import type { Config } from '../src/config.ts';

interface Seen {
	body: string;
	auth: string | undefined;
}

/** A one-shot-per-request HTTP stub. `reply` gets the request and returns status, headers and body. */
async function stub(reply: (seen: Seen, count: number) => [number, Record<string, string>, string]) {
	const requests: Seen[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const seen = { body: Buffer.concat(chunks).toString(), auth: req.headers.authorization };
			requests.push(seen);
			const [status, headers, body] = reply(seen, requests.length);
			res.writeHead(status, { 'content-type': 'application/json', ...headers });
			res.end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { url, requests, close: () => server.close() };
}

test('utxo: the amount is spliced into the JSON as a raw number literal', async () => {
	const s = await stub(() => [200, {}, '{"result":"abc123","error":null,"id":"autopay"}']);
	try {
		const payer = new UtxoPayer(s.url, 'user', 'pass');
		const txid = await payer.send('bcrt1qexample', 'BTC', '0.00012345');
		assert.equal(txid, 'abc123');
		assert.ok(s.requests[0]!.body.includes('"params":["bcrt1qexample",0.00012345]'), s.requests[0]!.body);
		assert.equal(s.requests[0]!.auth, `Basic ${Buffer.from('user:pass').toString('base64')}`);
	} finally {
		s.close();
	}
});

test('utxo: a whole amount and a leading zero stay valid JSON, bad amounts are refused', async () => {
	const s = await stub(() => [200, {}, '{"result":"t","error":null}']);
	try {
		const payer = new UtxoPayer(s.url, 'u', 'p');
		await payer.send('addr', 'BTC', '50');
		await payer.send('addr', 'BTC', '007.50');
		assert.ok(s.requests[0]!.body.includes('"params":["addr",50]'));
		assert.ok(s.requests[1]!.body.includes('"params":["addr",7.50]'));
		await assert.rejects(payer.send('addr', 'BTC', '1e3'));
		await assert.rejects(payer.send('addr', 'BTC', '0.123456789'));
		assert.equal(s.requests.length, 2);
	} finally {
		s.close();
	}
});

test('utxo: an RPC error is thrown', async () => {
	const s = await stub(() => [500, {}, '{"result":null,"error":{"code":-6,"message":"Insufficient funds"}}']);
	try {
		await assert.rejects(new UtxoPayer(s.url, 'u', 'p').send('a', 'BTC', '1'), /Insufficient funds/);
	} finally {
		s.close();
	}
});

test('monero: the amount is an integer in atomic units, no auth without a user', async () => {
	const s = await stub(() => [200, {}, '{"id":"0","jsonrpc":"2.0","result":{"tx_hash":"deadbeef"}}']);
	try {
		const txid = await new MoneroPayer(`${s.url}/json_rpc`).send('44Addr', 'XMR', '1.5');
		assert.equal(txid, 'deadbeef');
		assert.equal(s.requests.length, 1);
		assert.equal(s.requests[0]!.auth, undefined);
		assert.ok(s.requests[0]!.body.includes('"amount":1500000000000'), s.requests[0]!.body);
		const sent = JSON.parse(s.requests[0]!.body) as { method: string; params: { destinations: unknown[] } };
		assert.equal(sent.method, 'transfer');
		assert.deepEqual(sent.params.destinations, [{ amount: 1500000000000, address: '44Addr' }]);
	} finally {
		s.close();
	}
});

test('monero: digest auth answers the challenge when a user is set', async () => {
	const md5 = (t: string) => createHash('md5').update(t).digest('hex');
	const s = await stub((seen) => {
		if (!seen.auth) {
			return [
				401,
				{ 'www-authenticate': 'Digest realm="wallet", qop="auth", nonce="n0nce", algorithm=MD5' },
				'{}'
			];
		}
		const get = (k: string) =>
			new RegExp(`${k}=(?:"([^"]*)"|([^,\\s]+))`).exec(seen.auth!)?.slice(1).find(Boolean);
		const ha1 = md5('alice:wallet:secret');
		const ha2 = md5('POST:/json_rpc');
		const expected = md5(`${ha1}:n0nce:${get('nc')}:${get('cnonce')}:auth:${ha2}`);
		const ok = get('response') === expected && get('username') === 'alice' && get('uri') === '/json_rpc';
		return ok
			? [200, {}, '{"result":{"tx_hash":"cafe"}}']
			: [401, { 'www-authenticate': 'Digest realm="wallet", qop="auth", nonce="n0nce"' }, '{}'];
	});
	try {
		const txid = await new MoneroPayer(`${s.url}/json_rpc`, 'alice', 'secret').send('44A', 'XMR', '2');
		assert.equal(txid, 'cafe');
		assert.equal(s.requests.length, 2);
	} finally {
		s.close();
	}
});

const OVERRIDE = '0x1111111111111111111111111111111111111111';

test('evm: the ERC-20 transfer ABI has no outputs (Ethereum USDT returns nothing)', () => {
	const transfer = ERC20_ABI.find((e) => e.type === 'function' && e.name === 'transfer');
	assert.ok(transfer);
	assert.deepEqual(transfer.outputs, []);
	// The payer is built with a token override, as TOKEN_ADDRESS would give it.
	const payer = new EvmPayer({
		rpcUrl: 'http://127.0.0.1:1',
		privateKey: `0x${'11'.repeat(32)}`,
		network: 'ethereum',
		tokenAddress: OVERRIDE
	});
	assert.equal(payer.tokenFor('USDT'), OVERRIDE);
});

test('evm: address() is derived from the key', async () => {
	const payer = new EvmPayer({
		rpcUrl: 'http://127.0.0.1:1',
		privateKey: `0x${'11'.repeat(32)}`,
		network: 'bsc'
	});
	assert.match(await payer.address(), /^0x[0-9a-fA-F]{40}$/);
	assert.equal(payer.tokenFor('USDC'), '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
	assert.equal(payer.tokenFor('BNB'), undefined);
	assert.throws(() => payer.tokenFor('DAI'), /no token contract/);
});

test('evm: a native coin is never a token, even with TOKEN_ADDRESS set; an unknown coin throws', () => {
	const key = `0x${'11'.repeat(32)}`;
	const eth = new EvmPayer({
		rpcUrl: 'http://127.0.0.1:1',
		privateKey: key,
		network: 'ethereum',
		tokenAddress: OVERRIDE
	});
	assert.equal(eth.tokenFor('ETH'), undefined);
	const noOverride = new EvmPayer({ rpcUrl: 'http://127.0.0.1:1', privateKey: key, network: 'ethereum' });
	assert.equal(noOverride.tokenFor('ETH'), undefined);
	assert.throws(() => noOverride.tokenFor('DAI'), /TOKEN_ADDRESS/);
});

test('solana: SOL is native even with TOKEN_ADDRESS set; an unknown coin throws', () => {
	const key = JSON.stringify([...Keypair.generate().secretKey]);
	const sol = new SolanaPayer('http://127.0.0.1:1', key, OVERRIDE);
	assert.equal(sol.mintFor('SOL'), undefined);
	assert.equal(sol.mintFor('USDT'), OVERRIDE);
	const plain = new SolanaPayer('http://127.0.0.1:1', key);
	assert.equal(plain.mintFor('USDC'), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
	assert.throws(() => plain.mintFor('DAI'), /TOKEN_ADDRESS/);
});

test('monero: a non-JSON error page is reported clearly', async () => {
	const s = await stub(() => [500, { 'content-type': 'text/html' }, '<html>oops</html>']);
	try {
		await assert.rejects(new MoneroPayer(`${s.url}/json_rpc`).send('44A', 'XMR', '1'), /HTTP 500.*not JSON/);
	} finally {
		s.close();
	}
});

test('solana: the key is a base58 secret key or a JSON byte array', () => {
	const bytes = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
	const fromJson = parseSolanaKey(JSON.stringify([...bytes]));
	assert.deepEqual([...fromJson], [...bytes]);
	const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	let n = 0n;
	for (const b of bytes) n = n * 256n + BigInt(b);
	let text = '';
	while (n > 0n) {
		text = alphabet[Number(n % 58n)]! + text;
		n /= 58n;
	}
	assert.deepEqual([...parseSolanaKey(text)], [...bytes]);
	assert.throws(() => parseSolanaKey('not a key!'));
	assert.throws(() => parseSolanaKey('[1,2,3]'));
});

/** A JSON-RPC node that answers each method from `answers`, echoing the request id. */
async function rpcNode(answers: Record<string, unknown>) {
	const methods: string[] = [];
	const s = await stub((seen) => {
		const req = JSON.parse(seen.body) as { id: number; method: string };
		methods.push(req.method);
		if (!(req.method in answers)) {
			return [
				200,
				{},
				JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no' } })
			];
		}
		return [200, {}, JSON.stringify({ jsonrpc: '2.0', id: req.id, result: answers[req.method] })];
	});
	return { ...s, methods };
}

test('evm: a node of the other mainnet is refused; other chain ids are allowed', () => {
	assert.throws(() => checkChainId('bsc', 1), ConfigError);
	assert.throws(() => checkChainId('ethereum', 56), /chain id 56.*NETWORK is ethereum/);
	for (const [network, id] of [
		['ethereum', 1],
		['bsc', 56],
		['ethereum', 31337],
		['bsc', 97]
	] as const) {
		checkChainId(network, id);
	}
});

test('evm: check() and send() refuse a wrong node before anything is signed', async () => {
	const node = await rpcNode({ eth_chainId: '0x1' });
	try {
		const payer = new EvmPayer({ rpcUrl: node.url, privateKey: `0x${'11'.repeat(32)}`, network: 'bsc' });
		await assert.rejects(payer.check(), ConfigError);
		await assert.rejects(payer.send(OVERRIDE, 'BNB', '1'), /ethereum node \(chain id 1\)/);
		assert.deepEqual([...new Set(node.methods)], ['eth_chainId']);
	} finally {
		node.close();
	}
});

test('solana: amounts above 2^64 - 1 are refused, never truncated', async () => {
	assert.equal(toU64(2n ** 64n - 1n), 2n ** 64n - 1n);
	assert.throws(() => toU64(2n ** 64n), /64 bits/);
	const key = JSON.stringify([...Keypair.generate().secretKey]);
	const payer = new SolanaPayer('http://127.0.0.1:1', key);
	const to = Keypair.generate().publicKey.toBase58();
	await assert.rejects(payer.send(to, 'SOL', '18446744073.709551616'), /64 bits/);
});

test('solana: a mint must belong to a token program', () => {
	const mint = 'Mint1111111111111111111111111111111111111';
	assert.ok(tokenProgram(mint, TOKEN_PROGRAM_ID).equals(TOKEN_PROGRAM_ID));
	assert.ok(tokenProgram(mint, TOKEN_2022_PROGRAM_ID).equals(TOKEN_2022_PROGRAM_ID));
	assert.throws(() => tokenProgram(mint, SystemProgram.programId), /not a token mint/);
});

test('solana: a mint that is not a token mint, or not initialized, is never paid', async () => {
	const key = JSON.stringify([...Keypair.generate().secretKey]);
	const to = Keypair.generate().publicKey.toBase58();
	const mint = Keypair.generate().publicKey.toBase58();
	/** A mint account: 82 bytes, `isInitialized` at offset 45, decimals at 44. */
	const account = (owner: PublicKey, initialized: boolean) => {
		const data = Buffer.alloc(82);
		data[44] = 6;
		data[45] = initialized ? 1 : 0;
		return {
			context: { slot: 1 },
			value: {
				data: [data.toString('base64'), 'base64'],
				executable: false,
				lamports: 1_000_000,
				owner: owner.toBase58(),
				rentEpoch: 0,
				space: 82
			}
		};
	};
	for (const [owner, initialized, error] of [
		[SystemProgram.programId, true, /not a token mint/],
		[TOKEN_PROGRAM_ID, false, /not initialized/]
	] as const) {
		const node = await rpcNode({ getAccountInfo: account(owner, initialized) });
		try {
			await assert.rejects(new SolanaPayer(node.url, key, mint).send(to, 'USDT', '1'), error);
			assert.ok(!node.methods.includes('sendTransaction'), node.methods.join());
		} finally {
			node.close();
		}
	}
});

function config(network: string, coin: string): Config {
	return {
		key: 'k',
		api: 'http://x',
		network,
		coin,
		method: { network, coin, kind: 'invoice', min_usd: 5, max_usd: 100 },
		thresholdUsd: 10,
		topupUsd: 50,
		maxPerDayUsd: 100,
		checkInterval: 60,
		dryRun: false,
		stateFile: 'x'
	};
}

test('makePayer: picks the family and names a missing variable', () => {
	assert.throws(() => makePayer(config('bsc', 'USDT'), {}), /EVM_RPC_URL/);
	assert.throws(() => makePayer(config('tron', 'USDT'), {}), /Tron/);
	const env = { WALLET_RPC_URL: 'http://127.0.0.1:1', WALLET_RPC_USER: 'u', WALLET_RPC_PASSWORD: 'p' };
	assert.ok(makePayer(config('bitcoin', 'BTC'), env));
	assert.ok(makePayer(config('monero', 'XMR'), { MONERO_WALLET_RPC_URL: 'http://127.0.0.1:1' }));
});
