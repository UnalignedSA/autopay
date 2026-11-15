export interface Method {
	coin: string;
	network: string;
	kind: 'invoice' | 'deposit';
	min_usd: number;
	max_usd: number | null;
}

/** An invoice as the program keeps it: its own field names, times in milliseconds since 1970. */
export interface Invoice {
	kind: 'invoice';
	id: string;
	coin: string;
	network: string;
	amountUsd: number;
	amountCrypto: string;
	address: string;
	createdAt: number;
	expiresAt: number;
	/** waiting, confirming, partial, paid, expired or refunded */
	status: string;
}

export interface Deposit {
	kind: 'deposit';
	network: string;
	coins: string[];
	address: string;
	deposits: { txHash: string; credited: boolean }[];
}

export class ApiError extends Error {
	status: number;
	code: string | undefined;
	/** True for failures that may go away by themselves: network errors and 5xx. */
	transient: boolean;

	constructor(message: string, info: { status: number; code?: string; transient: boolean }) {
		super(message);
		this.status = info.status;
		this.code = info.code;
		this.transient = info.transient;
	}
}

export class Api {
	#base: string;
	#key: string;

	constructor(base: string, key: string) {
		this.#base = base;
		this.#key = key;
	}

	async balance(): Promise<number> {
		const body = (await this.#request('GET', '/balance')) as { balance?: unknown } | null;
		const balance = body?.balance;
		// A 2xx without a usable number is a glitch, never a zero balance.
		if (typeof balance !== 'number' || !Number.isFinite(balance)) {
			throw new ApiError('GET /balance: the answer has no balance', { status: 200, transient: true });
		}
		return balance;
	}

	/** Public: sent without the key. */
	async methods(): Promise<Method[]> {
		const what = 'GET /payments/methods';
		const { methods } = fields(what, await this.#request('GET', '/payments/methods', undefined, false));
		if (!Array.isArray(methods)) throw unexpected(what, 'methods');
		return methods as Method[];
	}

	/** 201 with an invoice, or 200 with the account's fixed deposit address. */
	async createPayment(body: Record<string, unknown>): Promise<Invoice | Deposit> {
		const what = 'POST /payments';
		const raw = fields(what, await this.#request('POST', '/payments', body));
		return raw.kind === 'deposit' ? parseDeposit(what, raw) : parseInvoice(what, raw);
	}

	async getPayment(id: string): Promise<Invoice> {
		const path = `/payments/${encodeURIComponent(id)}`;
		return parseInvoice(`GET ${path}`, fields(`GET ${path}`, await this.#request('GET', path)));
	}

	async deposit(network: string): Promise<Deposit> {
		const path = `/payments/deposit/${encodeURIComponent(network)}`;
		return parseDeposit(`GET ${path}`, fields(`GET ${path}`, await this.#request('GET', path)));
	}

	async #request(method: string, path: string, body?: unknown, auth = true): Promise<unknown> {
		let res: Response;
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

		let code: string | undefined;
		let message = res.statusText;
		try {
			const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
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

type Fields = Record<string, unknown>;

/** A 2xx answer that is not the documented one is a glitch: tried again later, never read as a payment. */
function unexpected(what: string, field: string): ApiError {
	return new ApiError(`${what}: unexpected response: no usable ${field}`, { status: 200, transient: true });
}

function fields(what: string, value: unknown): Fields {
	if (typeof value !== 'object' || value === null) throw unexpected(what, 'object');
	return value as Fields;
}

function text(what: string, raw: Fields, name: string): string {
	const value = raw[name];
	if (typeof value !== 'string') throw unexpected(what, name);
	return value;
}

function number(what: string, raw: Fields, name: string): number {
	const value = raw[name];
	if (typeof value !== 'number' || !Number.isFinite(value)) throw unexpected(what, name);
	return value;
}

/** The API names its fields in snake_case and gives times in seconds. */
function parseInvoice(what: string, raw: Fields): Invoice {
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

function parseDeposit(what: string, raw: Fields): Deposit {
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

function errorText(err: unknown): string {
	if (err instanceof Error) {
		const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
		return err.message + cause;
	}
	return String(err);
}
