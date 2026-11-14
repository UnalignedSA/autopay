export interface Method {
	coin: string;
	network: string;
	kind: 'invoice' | 'deposit';
	min_usd: number;
	max_usd: number | null;
}

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
		return (await this.#request('GET', '/payments/methods', undefined, false)) as Method[];
	}

	/** 201 with an invoice, or 200 with the account's fixed deposit address. */
	async createPayment(body: Record<string, unknown>): Promise<Invoice | Deposit> {
		return (await this.#request('POST', '/payments', body)) as Invoice | Deposit;
	}

	async getPayment(id: string): Promise<Invoice> {
		return (await this.#request('GET', `/payments/${encodeURIComponent(id)}`)) as Invoice;
	}

	async deposit(network: string): Promise<Deposit> {
		return (await this.#request('GET', `/payments/deposit/${encodeURIComponent(network)}`)) as Deposit;
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
		const text = [`${method} ${path}:`, res.status, code, message].filter(Boolean).join(' ');
		// 429 means slow down, not give up.
		throw new ApiError(text, {
			status: res.status,
			code,
			transient: res.status >= 500 || res.status === 429
		});
	}
}

function errorText(err: unknown): string {
	if (err instanceof Error) {
		const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
		return err.message + cause;
	}
	return String(err);
}
