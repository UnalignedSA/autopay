import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {'created' | 'sending' | 'sent' | 'done'} Phase */

/**
 * @typedef {object} Topup
 * @property {string} id Invoice id, or "deposit:<txid>" for a deposit ("deposit:pending" until the txid is known).
 * @property {'invoice' | 'deposit'} kind
 * @property {string} network
 * @property {string} coin
 * @property {number} amountUsd
 * @property {string} amountCrypto
 * @property {string} address
 * @property {number | null} expiresAt milliseconds since 1970; null for a deposit address, which never expires
 * @property {Phase} phase
 * @property {string | null} txid
 * @property {number} createdAt
 * @property {number | null} sentAt
 * @property {string | null} result final status: paid, expired, refunded or credited
 */

/**
 * @typedef {object} State
 * @property {1} version
 * @property {Topup[]} topups
 */

export class StateError extends Error {}

export class StateStore {
	#path;

	/** @param {string} path */
	constructor(path) {
		this.#path = path;
	}

	/**
	 * A missing file is an empty state. Anything else that is not a valid state is an error.
	 * @returns {State}
	 */
	load() {
		let text;
		try {
			text = readFileSync(this.#path, 'utf8');
		} catch (err) {
			if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { version: 1, topups: [] };
			throw new StateError(`cannot read state file ${this.#path}: ${/** @type {Error} */ (err).message}`);
		}
		let state;
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

	/**
	 * Writes to a temporary file, fsyncs it, then renames it over the real one.
	 * @param {State} state
	 */
	save(state) {
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

/** @param {any} value */
function isState(value) {
	if (typeof value !== 'object' || value === null) return false;
	const s = value;
	return s.version === 1 && Array.isArray(s.topups) && s.topups.every(isTopup);
}

/** @param {unknown} v */
const isString = (v) => typeof v === 'string';
/** @param {unknown} v */
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {(v: unknown) => boolean} check */
const orNull = (check) => (v) => v === null || check(v);

/** The file is meant to be hand-edited after a manual check, so every field is verified. */
/** @param {any} value */
function isTopup(value) {
	if (typeof value !== 'object' || value === null) return false;
	const t = value;
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
