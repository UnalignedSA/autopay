import { Api, ApiError } from './api.js';
import { EXIT_FATAL, EXIT_MANUAL_CHECK, Fatal, log, step, watchLoop } from './autopay.js';
import { apiBase, ConfigError, loadConfig, preflight } from './config.js';
import { makePayer } from './payers/index.js';
import { StateStore } from './state.js';

/** The wallet's node did not answer at start. Like the API being down, it is tried again on the next tick. */
class WalletUnreachable extends Error {}

/**
 * Checks the wallet's node: a wrong node is fatal, one that does not answer is retried.
 * @param {import('./autopay.js').Payer} payer
 */
async function checkWallet(payer) {
	try {
		await payer.check?.();
	} catch (err) {
		if (err instanceof ConfigError) throw err;
		const message = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
		throw new WalletUnreachable(`wallet RPC: ${message}`);
	}
}

/**
 * Checks the environment, then asks the API for the payment methods. Nothing leaves the machine before the checks pass.
 * @param {import('./config.js').Env} env
 */
async function setUp(env) {
	preflight(env);
	const methods = await new Api(apiBase(env), '').methods();
	let cfg = loadConfig(env, methods);
	const api = new Api(cfg.api, cfg.key);
	const payer = makePayer(cfg, env);
	// Before any payment is created: an EVM node of the other mainnet stops the program here.
	await checkWallet(payer);
	// An incomplete payment goes back to the wallet itself unless told otherwise.
	if (
		!cfg.refundAddress &&
		(cfg.network === 'ethereum' || cfg.network === 'bsc' || cfg.network === 'solana')
	) {
		cfg = { ...cfg, refundAddress: await payer.address() };
	}
	return { cfg, api, payer, store: new StateStore(cfg.stateFile) };
}

/** @returns {Promise<number>} the exit code */
async function main() {
	const mode = process.argv[2];
	if (mode !== 'once' && mode !== 'watch') {
		console.error('usage: autopay once | autopay watch');
		return EXIT_FATAL;
	}

	/** @type {Awaited<ReturnType<typeof setUp>> | undefined} */
	let session;
	// Set-up counts as part of a cycle: if the API is down at start, `watch` tries again on the next tick.
	/** @returns {Promise<import('./autopay.js').Outcome>} */
	const cycle = async () => {
		try {
			session ??= await setUp(process.env);
		} catch (err) {
			if ((err instanceof ApiError && err.transient) || err instanceof WalletUnreachable) {
				log(`retry: ${err.message}`);
				return { type: 'retry', reason: err.message };
			}
			throw err;
		}
		return step(session.cfg, session.api, session.payer, session.store, Date.now);
	};

	try {
		if (mode === 'once') return (await cycle()).type === 'manualCheck' ? EXIT_MANUAL_CHECK : 0;

		let stopping = false;
		let wake = () => {};
		for (const signal of ['SIGINT', 'SIGTERM']) {
			process.on(signal, () => {
				stopping = true;
				wake();
			});
		}
		/** @param {number} ms */
		const sleep = (ms) =>
			new Promise((resolve) => {
				const timer = setTimeout(done, ms);
				function done() {
					clearTimeout(timer);
					wake = () => {};
					resolve();
				}
				wake = done;
			});
		return await watchLoop(
			cycle,
			sleep,
			() => session?.cfg.checkInterval ?? 60,
			() => stopping
		);
	} catch (err) {
		if (err instanceof Fatal || err instanceof ConfigError || err instanceof ApiError) {
			console.error(`error: ${err.message}`);
		} else {
			console.error(err);
		}
		return EXIT_FATAL;
	}
}

process.exitCode = await main();
