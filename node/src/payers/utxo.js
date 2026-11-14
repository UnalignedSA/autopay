import { toBaseUnits } from '../amounts.js';

const DECIMALS = 8;

/** Bitcoin Core / Litecoin Core wallet over JSON-RPC (`sendtoaddress`), with basic auth. */
/** @implements {import('../autopay.js').Payer} */
export class UtxoPayer {
	#url;
	#user;
	#password;

	/** @param {string} url @param {string} user @param {string} password */
	constructor(url, user, password) {
		this.#url = url;
		this.#user = user;
		this.#password = password;
	}

	address() {
		return Promise.reject(new Error('the wallet address is not used for this network'));
	}

	/** @param {string} to @param {string} _coin @param {string} amountCrypto */
	async send(to, _coin, amountCrypto) {
		// Checks the string is a plain decimal with at most 8 decimals; the value itself is not used.
		toBaseUnits(amountCrypto, DECIMALS);
		// The amount must reach the node as the exact decimal digits. JSON.stringify of a float could change them,
		// so the number literal is spliced into the text. Leading zeros are not valid JSON and are dropped.
		const literal = amountCrypto.replace(/^0+(?=\d)/, '');
		const body = `{"jsonrpc":"1.0","id":"autopay","method":"sendtoaddress","params":[${JSON.stringify(to)},${literal}]}`;
		const res = await fetch(this.#url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Basic ${Buffer.from(`${this.#user}:${this.#password}`).toString('base64')}`
			},
			body
		});
		// Bitcoin Core answers errors with HTTP 500 and a JSON body, so read the body first.
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`wallet RPC answered HTTP ${res.status}`);
		}
		if (json.error) throw new Error(`wallet RPC error: ${json.error.message ?? 'unknown'}`);
		if (typeof json.result !== 'string') throw new Error('wallet RPC returned no transaction id');
		return json.result;
	}
}
