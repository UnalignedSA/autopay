import { ApiError } from './api.js';
import { StateError } from './state.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** An invoice with less time left than this is not paid: the payment could land after it expires. */
const MIN_TIME_LEFT = 5 * MINUTE;

/**
 * The part of the API that `step` uses. `Api` implements it; tests use a fake.
 * @typedef {object} ApiLike
 * @property {() => Promise<number>} balance
 * @property {(body: Record<string, unknown>) => Promise<Invoice | Deposit>} createPayment
 * @property {(id: string) => Promise<Invoice>} getPayment
 * @property {(network: string) => Promise<Deposit>} deposit
 */

/**
 * Sends crypto from the wallet. One implementation per chain family.
 * @typedef {object} Payer
 * @property {() => Promise<string>} address The wallet's own address.
 * @property {(to: string, coin: string, amountCrypto: string) => Promise<string>} send
 *   Sends `amountCrypto` (a decimal string) of `coin` to `to`. Returns the transaction id.
 */

/**
 * What one cycle did.
 * @typedef {{ type: 'idle' | 'pending' | 'sent' | 'dailyCap' }
 *   | { type: 'manualCheck' | 'retry', reason: string }} Outcome
 */

/** @typedef {(message: string) => void} Log */
/** @typedef {import('./api.js').Invoice} Invoice */
/** @typedef {import('./api.js').Deposit} Deposit */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./state.js').State} State */
/** @typedef {import('./state.js').StateStore} StateStore */
/** @typedef {import('./state.js').Topup} Topup */

/** Something that will not fix itself: bad configuration, bad key, corrupt state, rejected request. */
export class Fatal extends Error {}

export const EXIT_FATAL = 1;
export const EXIT_MANUAL_CHECK = 3;

/** @type {Log} */
export const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

/**
 * One check-and-maybe-top-up cycle.
 * @param {Config} cfg
 * @param {ApiLike} api
 * @param {Payer} payer
 * @param {StateStore} store
 * @param {() => number} now milliseconds since 1970
 * @param {Log} [out]
 * @returns {Promise<Outcome>}
 */
export async function step(cfg, api, payer, store, now, out = log) {
	try {
		return await cycle(cfg, api, payer, store, now, out);
	} catch (err) {
		if (err instanceof StateError) throw new Fatal(err.message);
		if (!(err instanceof ApiError)) throw err;
		if (err.transient) {
			out(`retry: ${err.message}`);
			return { type: 'retry', reason: err.message };
		}
		if (err.status === 401) throw new Fatal('the API key was rejected (401)');
		if (err.status === 403) {
			throw new Fatal(
				"this key cannot top up (403): a reseller's customer key can't, use the account's own key"
			);
		}
		throw new Fatal(err.message);
	}
}

/**
 * @param {Config} cfg @param {ApiLike} api @param {Payer} payer @param {StateStore} store
 * @param {() => number} now @param {Log} out
 * @returns {Promise<Outcome>}
 */
async function cycle(cfg, api, payer, store, now, out) {
	const state = store.load();
	const open = state.topups.find((t) => t.phase !== 'done');
	let topup;

	if (open?.phase === 'sending') {
		return manualCheck(
			out,
			'a send may or may not have gone out: check the wallet, then edit the state file'
		);
	}
	if (open?.phase === 'sent') return follow(api, state, store, open, out);

	if (open) {
		// Created but not sent: the program stopped between the two.
		const invoice = await api.getPayment(open.id);
		if (invoice.status === 'expired' || invoice.status === 'paid' || invoice.status === 'refunded') {
			finish(state, store, open, invoice.status, out);
			return { type: 'idle' };
		}
		if (invoice.status !== 'waiting' || (open.expiresAt ?? Infinity) - now() < MIN_TIME_LEFT) {
			out(`waiting ${open.id} (${invoice.status})`);
			return { type: 'pending' };
		}
		topup = open;
	} else {
		const balance = await api.balance();
		if (balance >= cfg.thresholdUsd) {
			out(`balance ${balance} >= threshold ${cfg.thresholdUsd}`);
			return { type: 'idle' };
		}

		const since = now() - DAY;
		const sentToday = state.topups
			.filter((t) => {
				const at = sendTime(t);
				return at !== null && at > since;
			})
			.reduce((sum, t) => sum + t.amountUsd, 0);
		if (sentToday + cfg.topupUsd > cfg.maxPerDayUsd) {
			out(`daily cap reached (${sentToday}/${cfg.maxPerDayUsd} USD in 24h)`);
			return { type: 'dailyCap' };
		}

		const created = await createTopup(cfg, api, now());
		if (cfg.dryRun) {
			out(`would send ${created.amountCrypto} ${created.coin} on ${created.network} to ${created.address}`);
			return { type: 'idle' };
		}
		topup = created;
		state.topups.push(topup);
		// A deposit has nothing to wait for: it goes straight to `sending`.
		if (topup.kind === 'invoice') store.save(state);
	}

	out(
		`created ${topup.kind} ${topup.id}: send ${topup.amountCrypto} ${topup.coin} on ${topup.network} to ${topup.address}`
	);
	return send(payer, state, store, topup, now, out);
}

/**
 * When money went out for this record, or null if it did not. A record edited by hand after a manual
 * check may lack `sentAt`: it still counts, dated by its creation, so the daily cap cannot be bypassed.
 * @param {Topup} t
 * @returns {number | null}
 */
function sendTime(t) {
	if (t.sentAt !== null) return t.sentAt;
	return t.txid !== null || t.phase === 'sending' || t.phase === 'sent' ? t.createdAt : null;
}

/**
 * Asks the API for a payment and turns the answer into a state record (not saved yet).
 * @param {Config} cfg @param {ApiLike} api @param {number} now
 * @returns {Promise<Topup>}
 */
async function createTopup(cfg, api, now) {
	const common = {
		network: cfg.network,
		coin: cfg.coin,
		amountUsd: cfg.topupUsd,
		txid: null,
		createdAt: now
	};

	if (cfg.method.kind === 'deposit') {
		const deposit = /** @type {Deposit} */ (
			await api.createPayment({ coin: cfg.coin, network: cfg.network })
		);
		if (deposit.network !== cfg.network || !deposit.coins.includes(cfg.coin)) {
			throw new Fatal(
				`the API answered with ${deposit.coins.join('/')} on ${deposit.network}, not ${cfg.coin} on ${cfg.network}`
			);
		}
		// A fixed deposit address is credited 1:1, so the dollars are the amount.
		return {
			...common,
			id: 'deposit:pending',
			kind: 'deposit',
			amountCrypto: String(cfg.topupUsd),
			address: deposit.address,
			expiresAt: null,
			phase: 'sending',
			sentAt: null,
			result: null
		};
	}

	const body = { amount_usd: cfg.topupUsd, coin: cfg.coin, network: cfg.network };
	if (cfg.refundAddress) body.refund_address = cfg.refundAddress;
	const invoice = /** @type {Invoice} */ (await api.createPayment(body));
	// Never pay something that is not what was asked for.
	if (invoice.coin !== cfg.coin || invoice.network !== cfg.network || invoice.amountUsd !== cfg.topupUsd) {
		throw new Fatal(
			`the API answered with ${invoice.amountUsd} USD in ${invoice.coin} on ${invoice.network}, ` +
				`not ${cfg.topupUsd} USD in ${cfg.coin} on ${cfg.network}`
		);
	}
	return {
		...common,
		id: invoice.id,
		kind: 'invoice',
		amountCrypto: invoice.amountCrypto,
		address: invoice.address,
		expiresAt: invoice.expiresAt,
		phase: 'created',
		sentAt: null,
		result: null
	};
}

/**
 * The one place money leaves the wallet. `sending` is on disk before the payer is called.
 * @param {Payer} payer @param {State} state @param {StateStore} store @param {Topup} topup
 * @param {() => number} now @param {Log} out
 * @returns {Promise<Outcome>}
 */
async function send(payer, state, store, topup, now, out) {
	topup.phase = 'sending';
	store.save(state);

	let txid;
	try {
		txid = await payer.send(topup.address, topup.coin, topup.amountCrypto);
	} catch (err) {
		// The record stays `sending`: we cannot know whether the transaction went out.
		const message = err instanceof Error ? err.message : String(err);
		return manualCheck(
			out,
			`the send failed (${message}) but may have gone out: check the wallet, then edit the state file`
		);
	}

	topup.phase = 'sent';
	topup.txid = txid;
	topup.sentAt = now();
	if (topup.kind === 'deposit') topup.id = `deposit:${txid}`;
	store.save(state);
	out(`sent ${txid}`);
	return { type: 'sent' };
}

/**
 * Follows a payment that was sent until the account is credited.
 * @param {ApiLike} api @param {State} state @param {StateStore} store @param {Topup} topup @param {Log} out
 * @returns {Promise<Outcome>}
 */
async function follow(api, state, store, topup, out) {
	if (topup.kind === 'deposit') {
		const { deposits } = await api.deposit(topup.network);
		if (deposits.find((d) => d.txHash === topup.txid)?.credited) {
			finish(state, store, topup, 'credited', out);
			return { type: 'idle' };
		}
		out(`waiting ${topup.id} (not credited yet)`);
		return { type: 'pending' };
	}

	const invoice = await api.getPayment(topup.id);
	if (invoice.status === 'paid' || invoice.status === 'refunded') {
		finish(state, store, topup, invoice.status, out);
		return { type: 'idle' };
	}
	if (invoice.status === 'expired') {
		// A payment that arrives after the invoice expired is still credited, so this may be fine.
		return manualCheck(
			out,
			`invoice ${topup.id} expired after the send: check your balance and the wallet, then edit the state file`
		);
	}
	out(`waiting ${topup.id} (${invoice.status})`);
	return { type: 'pending' };
}

/** @param {State} state @param {StateStore} store @param {Topup} topup @param {string} result @param {Log} out */
function finish(state, store, topup, result, out) {
	topup.phase = 'done';
	topup.result = result;
	store.save(state);
	out(`done ${topup.id} (${result})`);
}

/** @param {Log} out @param {string} reason @returns {Outcome} */
function manualCheck(out, reason) {
	out(`MANUAL CHECK: ${reason}`);
	return { type: 'manualCheck', reason };
}

/**
 * Runs `run` every `intervalSeconds()` until it asks for a manual check (exit 3) or `stopped()` is true
 * (exit 0). A Fatal error is thrown to the caller. Retry outcomes just wait for the next tick.
 * @param {() => Promise<Outcome>} run
 * @param {(ms: number) => Promise<void>} sleep
 * @param {() => number} intervalSeconds
 * @param {() => boolean} stopped
 * @returns {Promise<number>} the exit code
 */
export async function watchLoop(run, sleep, intervalSeconds, stopped) {
	while (!stopped()) {
		const outcome = await run();
		if (outcome.type === 'manualCheck') return EXIT_MANUAL_CHECK;
		await sleep(intervalSeconds() * 1000);
	}
	return 0;
}
