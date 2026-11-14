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
		const body = (await this.#request('GET', '/balance')) as { balance: number };
		return body.balance;
	}

	async methods(): Promise<Method[]> {
		return (await this.#request('GET', '/payments/methods')) as Method[];
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

	async #request(method: string, path: string, body?: unknown): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(this.#base + path, {
				method,
				headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(30_000)
			});
		} catch (err) {
			throw new ApiError(`network error: ${errorText(err)}`, { status: 0, transient: true });
		}
		if (res.ok) return res.json();

		let code: string | undefined;
		let message = res.statusText;
		try {
			const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
			code = parsed.error?.code;
			message = parsed.error?.message ?? message;
		} catch {
			// not JSON: keep the status text
		}
		throw new ApiError(`${method} ${path}: ${res.status} ${code ?? ''} ${message}`.replace('  ', ' '), {
			status: res.status,
			code,
			transient: res.status >= 500
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
