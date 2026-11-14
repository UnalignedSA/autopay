import { Api } from './api.ts';
import { Fatal, step, type Outcome, type Payer } from './autopay.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { StateStore } from './state.ts';

const EXIT_FATAL = 1;
const EXIT_MANUAL_CHECK = 3;

/** Builds the wallet for the configured network. The chain code comes later. */
function makePayer(_cfg: Config, _env: NodeJS.ProcessEnv): Payer {
	throw new Error('not implemented');
}

async function main(): Promise<number> {
	const mode = process.argv[2];
	if (mode !== 'once' && mode !== 'watch') {
		console.error('usage: autopay once | autopay watch');
		return EXIT_FATAL;
	}

	try {
		const baseUrl = process.env.UNALIGNED_API?.replace(/\/+$/, '') || undefined;
		const probe = new Api(baseUrl ?? 'https://api.unaligned.pw/v1', process.env.UNALIGNED_KEY ?? '');
		let cfg = loadConfig(process.env, await probe.methods());
		const api = new Api(cfg.api, cfg.key);
		const payer = makePayer(cfg, process.env);
		// An incomplete payment goes back to the wallet itself unless told otherwise.
		if (
			!cfg.refundAddress &&
			(cfg.network === 'ethereum' || cfg.network === 'bsc' || cfg.network === 'solana')
		) {
			cfg = { ...cfg, refundAddress: await payer.address() };
		}
		const store = new StateStore(cfg.stateFile);

		if (mode === 'once') return exitCode(await step(cfg, api, payer, store, Date.now));

		let stopping = false;
		let wake = () => {};
		for (const signal of ['SIGINT', 'SIGTERM'] as const) {
			process.on(signal, () => {
				stopping = true;
				wake();
			});
		}
		while (!stopping) {
			const outcome = await step(cfg, api, payer, store, Date.now);
			if (outcome.type === 'manualCheck') return EXIT_MANUAL_CHECK;
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, cfg.checkInterval * 1000).unref();
			});
		}
		return 0;
	} catch (err) {
		if (err instanceof Fatal || err instanceof ConfigError) {
			console.error(`error: ${err.message}`);
		} else {
			console.error(err);
		}
		return EXIT_FATAL;
	}
}

function exitCode(outcome: Outcome): number {
	return outcome.type === 'manualCheck' ? EXIT_MANUAL_CHECK : 0;
}

process.exitCode = await main();
