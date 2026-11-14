import { createHash, randomBytes } from 'node:crypto';
import { toBaseUnits } from '../amounts.js';

const DECIMALS = 12;

/** @param {string} text */
const md5 = (text) => createHash('md5').update(text).digest('hex');

/** Reads `key=value` pairs (quoted or not) out of a `WWW-Authenticate: Digest ...` header. */
/** @param {string} header @returns {Record<string, string>} */
function parseChallenge(header) {
	const out = /** @type {Record<string, string>} */ ({});
	for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
		out[m[1]] = m[2] ?? m[3] ?? '';
	}
	return out;
}

/** The `Authorization` header answering a Digest challenge (RFC 7616, MD5, qop=auth). */
/** @param {string} challenge @param {string} user @param {string} password @param {string} method @param {string} uri */
function digestHeader(challenge, user, password, method, uri) {
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
/** @implements {import('../autopay.js').Payer} */
export class MoneroPayer {
	#url;
	#user;
	#password;

	/** @param {string} url @param {string} [user] @param {string} [password] */
	constructor(url, user = '', password = '') {
		this.#url = url;
		this.#user = user;
		this.#password = password;
	}

	address() {
		return Promise.reject(new Error('the wallet address is not used for this network'));
	}

	/** @param {string} to @param {string} _coin @param {string} amountCrypto */
	async send(to, _coin, amountCrypto) {
		const atomic = toBaseUnits(amountCrypto, DECIMALS);
		// Integer atomic units. JSON.stringify cannot write a bigint, so the integer is spliced in as text.
		const body = `{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"destinations":[{"amount":${atomic},"address":${JSON.stringify(to)}}],"priority":0}}`;
		/** @param {string} [authorization] */
		const post = (authorization) =>
			fetch(this.#url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
				body
			});

		let res = await post();
		const challenge = res.headers.get('www-authenticate');
		if (res.status === 401 && this.#user && challenge?.toLowerCase().startsWith('digest')) {
			const uri = new URL(this.#url).pathname + new URL(this.#url).search;
			res = await post(digestHeader(challenge, this.#user, this.#password, 'POST', uri));
		}
		if (res.status === 401) throw new Error('wallet RPC refused the credentials');
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`wallet RPC answered HTTP ${res.status} with a body that is not JSON`);
		}
		if (json.error) throw new Error(`wallet RPC error: ${json.error.message ?? 'unknown'}`);
		if (!json.result?.tx_hash) throw new Error('wallet RPC returned no transaction hash');
		return json.result.tx_hash;
	}
}
