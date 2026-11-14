import { ConfigError, WALLET_VARS } from '../config.js';
import { EvmPayer } from './evm.js';
import { MoneroPayer } from './monero.js';
import { SolanaPayer } from './solana.js';
import { UtxoPayer } from './utxo.js';

/**
 * Builds the wallet for the configured network.
 * @param {import('../config.js').Config} cfg
 * @param {import('../config.js').Env} [env]
 * @returns {import('../autopay.js').Payer}
 */
export function makePayer(cfg, env = process.env) {
	// The variables each network needs are listed once, in config.js.
	for (const name of WALLET_VARS[cfg.network] ?? []) {
		if (!env[name]) throw new ConfigError(`${name} is required`);
	}
	const need = (name) => env[name] ?? '';
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
