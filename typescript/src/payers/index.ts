import type { Payer } from '../autopay.ts';
import { ConfigError, type Config } from '../config.ts';
import { EvmPayer } from './evm.ts';
import { MoneroPayer } from './monero.ts';
import { SolanaPayer } from './solana.ts';
import { UtxoPayer } from './utxo.ts';

type Env = Record<string, string | undefined>;

/** Builds the wallet for the configured network. */
export function makePayer(cfg: Config, env: Env = process.env): Payer {
	const need = (name: string): string => {
		const value = env[name];
		if (!value) throw new ConfigError(`${name} is required`);
		return value;
	};
	switch (cfg.network) {
		case 'ethereum':
		case 'bsc':
			return new EvmPayer({
				rpcUrl: need('EVM_RPC_URL'),
				privateKey: need('EVM_PRIVATE_KEY'),
				network: cfg.network,
				tokenAddress: cfg.tokenAddress
			});
		case 'solana':
			return new SolanaPayer(need('SOLANA_RPC_URL'), need('SOLANA_PRIVATE_KEY'), cfg.tokenAddress);
		case 'bitcoin':
		case 'litecoin':
			return new UtxoPayer(need('WALLET_RPC_URL'), need('WALLET_RPC_USER'), need('WALLET_RPC_PASSWORD'));
		case 'monero':
			return new MoneroPayer(
				need('MONERO_WALLET_RPC_URL'),
				env.MONERO_WALLET_RPC_USER ?? '',
				env.MONERO_WALLET_RPC_PASSWORD ?? ''
			);
		case 'tron':
			throw new ConfigError('Tron is not supported by this example yet');
		default:
			throw new ConfigError(`no wallet for network ${cfg.network}`);
	}
}
