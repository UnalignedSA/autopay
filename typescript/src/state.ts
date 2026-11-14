import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type Phase = 'created' | 'sending' | 'sent' | 'done';

export interface Topup {
	/** Invoice id, or "deposit:<txid>" for a deposit ("deposit:pending" until the txid is known). */
	id: string;
	kind: 'invoice' | 'deposit';
	network: string;
	coin: string;
	amountUsd: number;
	amountCrypto: string;
	address: string;
	/** Milliseconds since 1970. Null for a deposit address, which never expires. */
	expiresAt: number | null;
	phase: Phase;
	txid: string | null;
	createdAt: number;
	sentAt: number | null;
	/** Final status: paid, expired, refunded or credited. */
	result: string | null;
}

export interface State {
	version: 1;
	topups: Topup[];
}

export class StateError extends Error {}

export class StateStore {
	#path: string;

	constructor(path: string) {
		this.#path = path;
	}

	/** A missing file is an empty state. Anything else that is not a valid state is an error. */
	load(): State {
		let text: string;
		try {
			text = readFileSync(this.#path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, topups: [] };
			throw new StateError(`cannot read state file ${this.#path}: ${(err as Error).message}`);
		}
		let state: unknown;
		try {
			state = JSON.parse(text);
		} catch {
			throw new StateError(`state file ${this.#path} is not valid JSON; fix or remove it by hand`);
		}
		if (!isState(state)) {
			throw new StateError(`state file ${this.#path} has an unknown format; fix or remove it by hand`);
		}
		return state;
	}

	/** Writes to a temporary file, fsyncs it, then renames it over the real one. */
	save(state: State): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const tmp = `${this.#path}.tmp`;
		const fd = openSync(tmp, 'w', 0o600);
		try {
			writeSync(fd, JSON.stringify(state, null, 2) + '\n');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.#path);
		try {
			// Make the rename itself durable. Not possible on every platform (Windows): best effort.
			const dirFd = openSync(dirname(this.#path), 'r');
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch {
			// ignore
		}
	}
}

function isState(value: unknown): value is State {
	if (typeof value !== 'object' || value === null) return false;
	const s = value as { version?: unknown; topups?: unknown };
	return s.version === 1 && Array.isArray(s.topups) && s.topups.every(isTopup);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);

/** The file is meant to be hand-edited after a manual check, so every field is verified. */
function isTopup(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const t = value as Record<string, unknown>;
	return (
		isString(t.id) &&
		(t.kind === 'invoice' || t.kind === 'deposit') &&
		isString(t.network) &&
		isString(t.coin) &&
		isNumber(t.amountUsd) &&
		isString(t.amountCrypto) &&
		isString(t.address) &&
		orNull(isNumber)(t.expiresAt) &&
		(t.phase === 'created' || t.phase === 'sending' || t.phase === 'sent' || t.phase === 'done') &&
		orNull(isString)(t.txid) &&
		isNumber(t.createdAt) &&
		orNull(isNumber)(t.sentAt) &&
		orNull(isString)(t.result)
	);
}
