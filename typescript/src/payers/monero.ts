import { createHash, randomBytes } from 'node:crypto';
import type { Payer } from '../autopay.ts';
import { toBaseUnits } from '../amounts.ts';

const DECIMALS = 12;

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** Reads `key=value` pairs (quoted or not) out of a `WWW-Authenticate: Digest ...` header. */
function parseChallenge(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
		out[m[1]!] = m[2] ?? m[3] ?? '';
	}
	return out;
}

/** The `Authorization` header answering a Digest challenge (RFC 7616, MD5, qop=auth). */
function digestHeader(
	challenge: string,
	user: string,
	password: string,
	method: string,
	uri: string
): string {
	const c = parseChallenge(challenge);
	const realm = c.realm ?? '';
	const nonce = c.nonce ?? '';
	const nc = '00000001';
	const cnonce = randomBytes(8).toString('hex');
	const ha1 = md5(`${user}:${realm}:${password}`);
	const ha2 = md5(`${method}:${uri}`);
	const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
	const parts = [
		`username="${user}"`,
		`realm="${realm}"`,
		`nonce="${nonce}"`,
		`uri="${uri}"`,
		`algorithm=MD5`,
		`qop=auth`,
		`nc=${nc}`,
		`cnonce="${cnonce}"`,
		`response="${response}"`
	];
	if (c.opaque) parts.push(`opaque="${c.opaque}"`);
	return `Digest ${parts.join(', ')}`;
}

/** monero-wallet-rpc `transfer`. Digest auth is used only when a user is set. */
export class MoneroPayer implements Payer {
	private readonly url: string;
	private readonly user: string;
	private readonly password: string;

	constructor(url: string, user = '', password = '') {
		this.url = url;
		this.user = user;
		this.password = password;
	}

	address(): Promise<string> {
		return Promise.reject(new Error('the wallet address is not used for this network'));
	}

	async send(to: string, _coin: string, amountCrypto: string): Promise<string> {
		const atomic = toBaseUnits(amountCrypto, DECIMALS);
		// Integer atomic units. JSON.stringify cannot write a bigint, so the integer is spliced in as text.
		const body = `{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"destinations":[{"amount":${atomic},"address":${JSON.stringify(to)}}],"priority":0}}`;
		const post = (authorization?: string) =>
			fetch(this.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
				body
			});

		let res = await post();
		const challenge = res.headers.get('www-authenticate');
		if (res.status === 401 && this.user && challenge?.toLowerCase().startsWith('digest')) {
			const uri = new URL(this.url).pathname + new URL(this.url).search;
			res = await post(digestHeader(challenge, this.user, this.password, 'POST', uri));
		}
		if (res.status === 401) throw new Error('wallet RPC refused the credentials');
		const text = await res.text();
		let json: { result?: { tx_hash?: string }; error?: { message?: string } };
		try {
			json = JSON.parse(text) as typeof json;
		} catch {
			throw new Error(`wallet RPC answered HTTP ${res.status} with a body that is not JSON`);
		}
		if (json.error) throw new Error(`wallet RPC error: ${json.error.message ?? 'unknown'}`);
		if (!json.result?.tx_hash) throw new Error('wallet RPC returned no transaction hash');
		return json.result.tx_hash;
	}
}
