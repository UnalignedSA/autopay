/**
 * One way to pay, from GET /payments/methods.
 * @typedef {object} Method
 * @property {string} coin
 * @property {string} network
 * @property {'invoice' | 'deposit'} kind
 * @property {number} min_usd
 * @property {number | null} max_usd
 */

/**
 * An invoice as the program keeps it: its own field names, times in milliseconds since 1970.
 * @typedef {object} Invoice
 * @property {'invoice'} kind
 * @property {string} id
 * @property {string} coin
 * @property {string} network
 * @property {number} amountUsd
 * @property {string} amountCrypto
 * @property {string} address
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {string} status waiting, confirming, partial, paid, expired or refunded
 */

/**
 * The account's fixed deposit address on a network.
 * @typedef {object} Deposit
 * @property {'deposit'} kind
 * @property {string} network
 * @property {string[]} coins
 * @property {string} address
 * @property {{ txHash: string, credited: boolean }[]} deposits
 */

export class ApiError extends Error {
	/** @type {number} */
	status;
	/** @type {string | undefined} */
	code;
	/** True for failures that may go away by themselves: network errors and 5xx. */
	transient;

	/** @param {string} message @param {{ status: number, code?: string, transient: boolean }} info */
	constructor(message, info) {
		super(message);
		this.status = info.status;
		this.code = info.code;
		this.transient = info.transient;
	}
}

export class Api {
	#base;
	#key;

	/** @param {string} base the API URL without a trailing slash @param {string} key */
	constructor(base, key) {
		this.#base = base;
		this.#key = key;
	}

	/** @returns {Promise<number>} */
	async balance() {
		const body = await this.#request('GET', '/balance');
		const balance = body?.balance;
		// A 2xx without a usable number is a glitch, never a zero balance.
		if (typeof balance !== 'number' || !Number.isFinite(balance)) {
			throw new ApiError('GET /balance: the answer has no balance', { status: 200, transient: true });
		}
		return balance;
	}

	/**
	 * Public: sent without the key.
	 * @returns {Promise<Method[]>}
	 */
	async methods() {
		const what = 'GET /payments/methods';
		const { methods } = fields(what, await this.#request('GET', '/payments/methods', undefined, false));
		if (!Array.isArray(methods)) throw unexpected(what, 'methods');
		return methods;
	}

	/**
	 * 201 with an invoice, or 200 with the account's fixed deposit address.
	 * @param {Record<string, unknown>} body
	 * @returns {Promise<Invoice | Deposit>}
	 */
	async createPayment(body) {
		const what = 'POST /payments';
		const raw = fields(what, await this.#request('POST', '/payments', body));
		return raw.kind === 'deposit' ? parseDeposit(what, raw) : parseInvoice(what, raw);
	}

	/** @param {string} id @returns {Promise<Invoice>} */
	async getPayment(id) {
		const path = `/payments/${encodeURIComponent(id)}`;
		return parseInvoice(`GET ${path}`, fields(`GET ${path}`, await this.#request('GET', path)));
	}

	/** @param {string} network @returns {Promise<Deposit>} */
	async deposit(network) {
		const path = `/payments/deposit/${encodeURIComponent(network)}`;
		return parseDeposit(`GET ${path}`, fields(`GET ${path}`, await this.#request('GET', path)));
	}

	/** @param {string} method @param {string} path @param {unknown} [body] @param {boolean} [auth] */
	async #request(method, path, body, auth = true) {
		let res;
		try {
			res = await fetch(this.#base + path, {
				method,
				headers: auth
					? { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' }
					: { 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(30_000)
			});
		} catch (err) {
			throw new ApiError(`network error: ${errorText(err)}`, { status: 0, transient: true });
		}
		if (res.ok) {
			try {
				return await res.json();
			} catch (err) {
				// The body was cut off or is not JSON: treat it like any other glitch and try again later.
				throw new ApiError(`${method} ${path}: unreadable response: ${errorText(err)}`, {
					status: res.status,
					transient: true
				});
			}
		}

		let code;
		let message = res.statusText;
		try {
			const parsed = await res.json();
			code = parsed.error?.code;
			message = parsed.error?.message ?? message;
		} catch {
			// not JSON: keep the status text
		}
		// The request id is what support asks for.
		const requestId = res.headers.get('x-request-id');
		const text = [`${method} ${path}:`, res.status, code, message, requestId && `(request ${requestId})`]
			.filter(Boolean)
			.join(' ');
		// 429 means slow down, not give up.
		throw new ApiError(text, {
			status: res.status,
			code,
			transient: res.status >= 500 || res.status === 429
		});
	}
}

/** @typedef {Record<string, unknown>} Fields */

/**
 * A 2xx answer that is not the documented one is a glitch: tried again later, never read as a payment.
 * @param {string} what @param {string} field
 */
function unexpected(what, field) {
	return new ApiError(`${what}: unexpected response: no usable ${field}`, { status: 200, transient: true });
}

/** @param {string} what @param {unknown} value @returns {Fields} */
function fields(what, value) {
	if (typeof value !== 'object' || value === null) throw unexpected(what, 'object');
	return /** @type {Fields} */ (value);
}

/** @param {string} what @param {Fields} raw @param {string} name @returns {string} */
function text(what, raw, name) {
	const value = raw[name];
	if (typeof value !== 'string') throw unexpected(what, name);
	return value;
}

/** @param {string} what @param {Fields} raw @param {string} name @returns {number} */
function number(what, raw, name) {
	const value = raw[name];
	if (typeof value !== 'number' || !Number.isFinite(value)) throw unexpected(what, name);
	return value;
}

/**
 * The API names its fields in snake_case and gives times in seconds.
 * @param {string} what @param {Fields} raw @returns {Invoice}
 */
function parseInvoice(what, raw) {
	return {
		kind: 'invoice',
		id: text(what, raw, 'id'),
		coin: text(what, raw, 'coin'),
		network: text(what, raw, 'network'),
		amountUsd: number(what, raw, 'amount_usd'),
		amountCrypto: text(what, raw, 'amount_crypto'),
		address: text(what, raw, 'address'),
		createdAt: number(what, raw, 'created_at') * 1000,
		expiresAt: number(what, raw, 'expires_at') * 1000,
		status: text(what, raw, 'status')
	};
}

/** @param {string} what @param {Fields} raw @returns {Deposit} */
function parseDeposit(what, raw) {
	const { coins, deposits = [] } = raw;
	if (!Array.isArray(coins) || !coins.every((c) => typeof c === 'string')) throw unexpected(what, 'coins');
	if (!Array.isArray(deposits)) throw unexpected(what, 'deposits');
	return {
		kind: 'deposit',
		network: text(what, raw, 'network'),
		coins,
		address: text(what, raw, 'address'),
		deposits: deposits.map((d) => {
			const entry = fields(what, d);
			return { txHash: text(what, entry, 'tx_hash'), credited: entry.credited === true };
		})
	};
}

/** @param {unknown} err */
function errorText(err) {
	if (err instanceof Error) {
		const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
		return err.message + cause;
	}
	return String(err);
}
