//! One wallet per chain family.

mod evm;
mod monero;
mod solana;
mod utxo;

use async_trait::async_trait;

pub use evm::{EvmOptions, EvmPayer};
pub use monero::MoneroPayer;
pub use solana::SolanaPayer;
pub use utxo::UtxoPayer;

use crate::config::{Config, ConfigError, Env, var, wallet_vars};

/// Sends crypto from the wallet.
#[async_trait]
pub trait Payer: Send + Sync {
    /// The wallet's own address.
    async fn address(&self) -> anyhow::Result<String>;
    /// Sends `amount` (a decimal string) of `coin` to `to`. Returns the transaction id.
    async fn send(&self, to: &str, coin: &str, amount: &str) -> anyhow::Result<String>;
}

/// Builds the wallet for the configured network.
pub fn make_payer(cfg: &Config, env: &Env) -> Result<Box<dyn Payer>, ConfigError> {
    let s = &cfg.settings;
    // The variables each network needs are listed once, in config.rs.
    for name in wallet_vars(&s.network) {
        if var(env, name).is_none() {
            return Err(ConfigError(format!("{name} is required")));
        }
    }
    let need = |name: &str| var(env, name).unwrap_or_default().to_string();
    let payer: Box<dyn Payer> = match s.network.as_str() {
        "ethereum" | "bsc" => Box::new(EvmPayer::new(EvmOptions {
            rpc_url: need("EVM_RPC_URL"),
            private_key: need("EVM_PRIVATE_KEY"),
            network: s.network.clone(),
            token_address: s.token_address.clone(),
        })?),
        "solana" => Box::new(SolanaPayer::new(
            &need("SOLANA_RPC_URL"),
            &need("SOLANA_PRIVATE_KEY"),
            s.token_address.clone(),
        )?),
        "bitcoin" | "litecoin" => Box::new(UtxoPayer::new(
            &need("WALLET_RPC_URL"),
            &need("WALLET_RPC_USER"),
            &need("WALLET_RPC_PASSWORD"),
        )),
        "monero" => Box::new(MoneroPayer::new(
            &need("MONERO_WALLET_RPC_URL"),
            &need("MONERO_WALLET_RPC_USER"),
            &need("MONERO_WALLET_RPC_PASSWORD"),
        )),
        "tron" => return Err(ConfigError("Tron is not supported by this example yet".into())),
        other => return Err(ConfigError(format!("no wallet for network {other}"))),
    };
    Ok(payer)
}

/// The HTTP client for the wallet RPCs. No overall timeout: a wallet can take its time to build and sign a
/// transfer (Monero especially), and cutting it short would leave the send in doubt.
fn wallet_http() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{MethodKind, PaymentMethod};
    use crate::config::Settings;

    pub fn config(network: &str, coin: &str) -> Config {
        Config {
            settings: Settings {
                key: "k".into(),
                api: "http://x".into(),
                network: network.into(),
                coin: coin.into(),
                threshold_usd: 10.0,
                topup_usd: 50,
                max_per_day_usd: 100,
                check_interval: 60,
                dry_run: false,
                refund_address: None,
                state_file: "x".into(),
                token_address: None,
            },
            method: PaymentMethod {
                coin: coin.into(),
                network: network.into(),
                kind: MethodKind::Invoice,
                min_usd: 5.0,
                max_usd: Some(100.0),
            },
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn error(result: Result<Box<dyn Payer>, ConfigError>) -> String {
        match result {
            Ok(_) => panic!("expected an error"),
            Err(e) => e.0,
        }
    }

    #[test]
    fn picks_the_family_and_names_a_missing_variable() {
        assert!(error(make_payer(&config("bsc", "USDT"), &Env::new())).contains("EVM_RPC_URL"));
        assert!(error(make_payer(&config("tron", "USDT"), &Env::new())).contains("Tron"));
        let utxo = env(&[
            ("WALLET_RPC_URL", "http://127.0.0.1:1"),
            ("WALLET_RPC_USER", "u"),
            ("WALLET_RPC_PASSWORD", "p"),
        ]);
        assert!(make_payer(&config("bitcoin", "BTC"), &utxo).is_ok());
        let monero = env(&[("MONERO_WALLET_RPC_URL", "http://127.0.0.1:1")]);
        assert!(make_payer(&config("monero", "XMR"), &monero).is_ok());
        let evm = env(&[
            ("EVM_RPC_URL", "http://127.0.0.1:1"),
            ("EVM_PRIVATE_KEY", &"11".repeat(32)),
        ]);
        assert!(make_payer(&config("ethereum", "ETH"), &evm).is_ok());
    }

    #[test]
    fn a_bad_key_is_a_config_error() {
        let evm = env(&[("EVM_RPC_URL", "http://127.0.0.1:1"), ("EVM_PRIVATE_KEY", "0xnope")]);
        assert!(error(make_payer(&config("bsc", "USDT"), &evm)).contains("EVM_PRIVATE_KEY"));
        let sol = env(&[
            ("SOLANA_RPC_URL", "http://127.0.0.1:1"),
            ("SOLANA_PRIVATE_KEY", "[1,2,3]"),
        ]);
        assert!(error(make_payer(&config("solana", "SOL"), &sol)).contains("SOLANA_PRIVATE_KEY"));
    }
}
