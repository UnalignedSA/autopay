import { Api, ApiError } from './api.ts';
import {
	EXIT_FATAL,
	EXIT_MANUAL_CHECK,
	Fatal,
	log,
	step,
	watchLoop,
	type Outcome,
	type Payer
} from './autopay.ts';
import { apiBase, ConfigError, loadConfig, preflight, type Config } from './config.ts';
import { StateStore } from './state.ts';

/** Builds the wallet for the configured network. The chain code comes later. */
function makePayer(_cfg: Config, _env: NodeJS.ProcessEnv): Payer {
	throw new Error('not implemented');
}

interface Session {
	cfg: Config;
	api: Api;
	payer: Payer;
	store: StateStore;
}

/** Checks the environment, then asks the API for the payment methods. Nothing leaves the machine before the checks pass. */
async function setUp(env: NodeJS.ProcessEnv): Promise<Session> {
	preflight(env);
	const methods = await new Api(apiBase(env), '').methods();
	let cfg = loadConfig(env, methods);
	const api = new Api(cfg.api, cfg.key);
	const payer = makePayer(cfg, env);
	// An incomplete payment goes back to the wallet itself unless told otherwise.
	if (
		!cfg.refundAddress &&
		(cfg.network === 'ethereum' || cfg.network === 'bsc' || cfg.network === 'solana')
	) {
		cfg = { ...cfg, refundAddress: await payer.address() };
	}
	return { cfg, api, payer, store: new StateStore(cfg.stateFile) };
}

async function main(): Promise<number> {
	const mode = process.argv[2];
	if (mode !== 'once' && mode !== 'watch') {
		console.error('usage: autopay once | autopay watch');
		return EXIT_FATAL;
	}

	let session: Session | undefined;
	// Set-up counts as part of a cycle: if the API is down at start, `watch` tries again on the next tick.
	const cycle = async (): Promise<Outcome> => {
		try {
			session ??= await setUp(process.env);
		} catch (err) {
			if (err instanceof ApiError && err.transient) {
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
		for (const signal of ['SIGINT', 'SIGTERM'] as const) {
			process.on(signal, () => {
				stopping = true;
				wake();
			});
		}
		const sleep = (ms: number) =>
			new Promise<void>((resolve) => {
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
