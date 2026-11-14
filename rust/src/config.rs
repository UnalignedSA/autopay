//! Reads and checks the environment.

use std::collections::HashMap;
use std::path::Path;

use thiserror::Error;

use crate::api::PaymentMethod;

/// The environment, as name/value pairs: the process environment plus `.env`.
pub type Env = HashMap<String, String>;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ConfigError(pub String);

pub const DEFAULT_API: &str = "https://api.unaligned.pw/v1";
const DEFAULT_STATE_FILE: &str = "./autopay-state.json";
const DEFAULT_CHECK_INTERVAL: &str = "60";
const MIN_CHECK_INTERVAL: u64 = 15;

/// Everything that can be checked without asking the API.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub key: String,
    pub api: String,
    pub network: String,
    pub coin: String,
    pub threshold_usd: f64,
    pub topup_usd: u64,
    pub max_per_day_usd: u64,
    /// Seconds.
    pub check_interval: u64,
    pub dry_run: bool,
    pub refund_address: Option<String>,
    pub state_file: String,
    pub token_address: Option<String>,
}

/// The settings plus the payment method the API offers for them.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub settings: Settings,
    pub method: PaymentMethod,
}

/// The wallet variables each network needs.
pub fn wallet_vars(network: &str) -> &'static [&'static str] {
    match network {
        "ethereum" | "bsc" => &["EVM_RPC_URL", "EVM_PRIVATE_KEY"],
        "solana" => &["SOLANA_RPC_URL", "SOLANA_PRIVATE_KEY"],
        "bitcoin" | "litecoin" => &["WALLET_RPC_URL", "WALLET_RPC_USER", "WALLET_RPC_PASSWORD"],
        "monero" => &["MONERO_WALLET_RPC_URL"],
        _ => &[],
    }
}

/// The coin each network's own currency is called. Every other coin is a token.
pub fn native_coin(network: &str) -> Option<&'static str> {
    match network {
        "ethereum" => Some("ETH"),
        "bsc" => Some("BNB"),
        "solana" => Some("SOL"),
        "bitcoin" => Some("BTC"),
        "litecoin" => Some("LTC"),
        "monero" => Some("XMR"),
        _ => None,
    }
}

/// A variable's value, or `None` when it is unset or empty.
pub fn var<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str).filter(|v| !v.is_empty())
}

/// The API base URL: `UNALIGNED_API` or the public default, without a trailing slash.
pub fn api_base(env: &Env) -> String {
    var(env, "UNALIGNED_API")
        .unwrap_or(DEFAULT_API)
        .trim_end_matches('/')
        .to_string()
}

/// Everything that can be checked without asking the API. Run it before any network call.
pub fn preflight(env: &Env) -> Result<Settings, ConfigError> {
    let key = required(env, "UNALIGNED_KEY")?;
    let network = required(env, "NETWORK")?.to_lowercase();
    let coin = required(env, "COIN")?.to_uppercase();
    if network == "tron" {
        return Err(ConfigError("Tron is not supported by this example yet".into()));
    }

    let threshold_usd = number(required(env, "THRESHOLD_USD")?)
        .filter(|t| *t > 0.0)
        .ok_or_else(|| ConfigError("THRESHOLD_USD must be a number above 0".into()))?;
    let topup_usd = whole_number(env, "TOPUP_USD")?;
    let max_per_day_usd = whole_number(env, "MAX_PER_DAY_USD")?;
    if max_per_day_usd < topup_usd {
        return Err(ConfigError("MAX_PER_DAY_USD must be at least TOPUP_USD".into()));
    }

    let check_interval = number(var(env, "CHECK_INTERVAL").unwrap_or(DEFAULT_CHECK_INTERVAL))
        .filter(|n| n.fract() == 0.0 && *n >= MIN_CHECK_INTERVAL as f64)
        .ok_or_else(|| ConfigError("CHECK_INTERVAL must be a whole number of seconds, at least 15".into()))?
        as u64;

    let token_address = var(env, "TOKEN_ADDRESS").map(str::to_string);
    if token_address.is_some() && native_coin(&network) == Some(coin.as_str()) {
        return Err(ConfigError(format!(
            "TOKEN_ADDRESS is for tokens: {coin} is the native coin of {network}, unset TOKEN_ADDRESS"
        )));
    }

    for name in wallet_vars(&network) {
        required(env, name)?;
    }

    Ok(Settings {
        key: key.to_string(),
        api: api_base(env),
        network,
        coin,
        threshold_usd,
        topup_usd,
        max_per_day_usd,
        check_interval,
        dry_run: env.get("DRY_RUN").is_some_and(|v| v == "1"),
        refund_address: var(env, "REFUND_ADDRESS").map(str::to_string),
        state_file: var(env, "STATE_FILE").unwrap_or(DEFAULT_STATE_FILE).to_string(),
        token_address,
    })
}

/// Reads and checks the environment. `methods` is the answer of `GET /payments/methods`.
pub fn load_config(env: &Env, methods: &[PaymentMethod]) -> Result<Config, ConfigError> {
    let settings = preflight(env)?;
    let (network, coin, topup) = (&settings.network, &settings.coin, settings.topup_usd as f64);

    let Some(method) = methods.iter().find(|m| &m.network == network && &m.coin == coin) else {
        let pairs: Vec<String> = methods.iter().map(|m| format!("{}/{}", m.coin, m.network)).collect();
        return Err(ConfigError(format!(
            "{coin} on {network} is not offered. Valid COIN/NETWORK pairs: {}",
            pairs.join(", ")
        )));
    };
    if topup < method.min_usd {
        return Err(ConfigError(format!(
            "TOPUP_USD must be at least {} for {coin} on {network}",
            method.min_usd
        )));
    }
    if let Some(max) = method.max_usd
        && topup > max
    {
        return Err(ConfigError(format!(
            "TOPUP_USD must be at most {max} for {coin} on {network}"
        )));
    }
    let method = method.clone();
    Ok(Config { settings, method })
}

fn required<'a>(env: &'a Env, name: &str) -> Result<&'a str, ConfigError> {
    var(env, name).ok_or_else(|| ConfigError(format!("{name} is required")))
}

/// A finite number, or `None`.
fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

fn whole_number(env: &Env, name: &str) -> Result<u64, ConfigError> {
    let text = required(env, name)?;
    let invalid = || ConfigError(format!("{name} must be a whole number of dollars"));
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    text.parse().map_err(|_| invalid())
}

/// Adds the `KEY=value` lines of a `.env` file to `env`, never overriding a variable that is already set.
/// A missing file is fine. Values are taken literally: `$NAME` is not expanded.
pub fn load_env_file(path: &Path, env: &mut Env) -> Result<(), ConfigError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(ConfigError(format!("cannot read {}: {err}", path.display()))),
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty() && !env.contains_key(name) {
            env.insert(name.to_string(), env_value(value.trim()).to_string());
        }
    }
    Ok(())
}

/// A value in single or double quotes is taken as it is between them; an unquoted one ends at ` #`.
fn env_value(raw: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = raw.strip_prefix(quote)
            && let Some(end) = inner.find(quote)
        {
            return &inner[..end];
        }
    }
    raw.split(" #").next().unwrap_or_default().trim_end()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::MethodKind;

    fn methods() -> Vec<PaymentMethod> {
        let method = |coin: &str, network: &str, kind, min_usd, max_usd| PaymentMethod {
            coin: coin.into(),
            network: network.into(),
            kind,
            min_usd,
            max_usd,
        };
        vec![
            method("USDT", "bsc", MethodKind::Invoice, 5.0, Some(50000.0)),
            method("USDT", "solana", MethodKind::Deposit, 1.0, None),
            method("BTC", "bitcoin", MethodKind::Invoice, 5.0, Some(50000.0)),
        ]
    }

    fn base() -> Env {
        [
            ("UNALIGNED_KEY", "key"),
            ("NETWORK", "bsc"),
            ("COIN", "USDT"),
            ("THRESHOLD_USD", "10"),
            ("TOPUP_USD", "50"),
            ("MAX_PER_DAY_USD", "100"),
            ("EVM_RPC_URL", "http://localhost:8545"),
            ("EVM_PRIVATE_KEY", "0x01"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn with(pairs: &[(&str, &str)]) -> Env {
        let mut env = base();
        for (k, v) in pairs {
            env.insert(k.to_string(), v.to_string());
        }
        env
    }

    fn without(name: &str) -> Env {
        let mut env = base();
        env.remove(name);
        env
    }

    fn error(result: Result<impl std::fmt::Debug, ConfigError>) -> String {
        result.expect_err("expected a config error").0
    }

    #[test]
    fn reads_a_valid_configuration_and_applies_defaults() {
        let cfg = load_config(&base(), &methods()).unwrap();
        let s = &cfg.settings;
        assert_eq!(s.network, "bsc");
        assert_eq!(s.coin, "USDT");
        assert_eq!(s.threshold_usd, 10.0);
        assert_eq!(s.topup_usd, 50);
        assert_eq!(s.check_interval, 60);
        assert!(!s.dry_run);
        assert_eq!(s.state_file, "./autopay-state.json");
        assert_eq!(s.api, DEFAULT_API);
        assert_eq!(cfg.method.kind, MethodKind::Invoice);
    }

    #[test]
    fn strips_a_trailing_slash_from_unaligned_api() {
        let cfg = load_config(&with(&[("UNALIGNED_API", "https://example.test/v1/")]), &methods()).unwrap();
        assert_eq!(cfg.settings.api, "https://example.test/v1");
    }

    #[test]
    fn tron_is_not_supported() {
        assert!(error(load_config(&with(&[("NETWORK", "tron")]), &methods())).contains("Tron is not supported"));
    }

    #[test]
    fn a_pair_that_is_not_offered_lists_the_valid_pairs() {
        let message = error(load_config(&with(&[("COIN", "DOGE")]), &methods()));
        assert!(
            message.contains("USDT/bsc") && message.contains("BTC/bitcoin"),
            "{message}"
        );
    }

    #[test]
    fn topup_below_the_method_minimum_is_rejected() {
        assert!(error(load_config(&with(&[("TOPUP_USD", "3")]), &methods())).contains("TOPUP_USD"));
    }

    #[test]
    fn topup_above_the_method_maximum_is_rejected() {
        let env = with(&[("TOPUP_USD", "60000"), ("MAX_PER_DAY_USD", "70000")]);
        assert!(error(load_config(&env, &methods())).contains("TOPUP_USD"));
    }

    #[test]
    fn topup_must_be_a_whole_number() {
        assert!(error(load_config(&with(&[("TOPUP_USD", "5.5")]), &methods())).contains("TOPUP_USD"));
    }

    #[test]
    fn max_per_day_must_cover_one_topup() {
        let message = error(load_config(&with(&[("MAX_PER_DAY_USD", "40")]), &methods()));
        assert!(message.contains("MAX_PER_DAY_USD"));
    }

    #[test]
    fn threshold_must_be_above_zero() {
        for bad in ["0", "-1", "abc", "NaN", "inf"] {
            let message = error(load_config(&with(&[("THRESHOLD_USD", bad)]), &methods()));
            assert!(message.contains("THRESHOLD_USD"), "{bad}");
        }
    }

    #[test]
    fn check_interval_below_15_seconds_is_rejected() {
        for bad in ["5", "15.5", "abc"] {
            let message = error(load_config(&with(&[("CHECK_INTERVAL", bad)]), &methods()));
            assert!(message.contains("CHECK_INTERVAL"), "{bad}");
        }
        let cfg = load_config(&with(&[("CHECK_INTERVAL", "15")]), &methods()).unwrap();
        assert_eq!(cfg.settings.check_interval, 15);
    }

    #[test]
    fn a_missing_wallet_variable_is_named() {
        assert!(error(load_config(&without("EVM_PRIVATE_KEY"), &methods())).contains("EVM_PRIVATE_KEY"));
    }

    #[test]
    fn a_missing_key_is_named() {
        assert!(error(load_config(&without("UNALIGNED_KEY"), &methods())).contains("UNALIGNED_KEY"));
    }

    #[test]
    fn a_deposit_method_has_no_maximum_and_needs_the_solana_wallet() {
        let env = with(&[
            ("NETWORK", "solana"),
            ("TOPUP_USD", "1"),
            ("MAX_PER_DAY_USD", "1000000"),
        ]);
        assert!(error(load_config(&env, &methods())).contains("SOLANA_RPC_URL"));
        let mut env = env;
        env.insert("SOLANA_RPC_URL".into(), "http://x".into());
        env.insert("SOLANA_PRIVATE_KEY".into(), "k".into());
        assert_eq!(load_config(&env, &methods()).unwrap().method.kind, MethodKind::Deposit);
    }

    #[test]
    fn dry_run_is_read() {
        assert!(
            load_config(&with(&[("DRY_RUN", "1")]), &methods())
                .unwrap()
                .settings
                .dry_run
        );
    }

    #[test]
    fn preflight_checks_everything_it_can_without_the_api() {
        assert!(error(preflight(&with(&[("NETWORK", "tron")]))).contains("Tron"));
        assert!(error(preflight(&with(&[("UNALIGNED_KEY", "")]))).contains("UNALIGNED_KEY"));
        assert!(error(preflight(&with(&[("EVM_RPC_URL", "")]))).contains("EVM_RPC_URL"));
        assert_eq!(preflight(&base()).unwrap().topup_usd, 50);
    }

    #[test]
    fn token_address_with_a_native_coin_is_rejected() {
        let token = ("TOKEN_ADDRESS", "0x1111111111111111111111111111111111111111");
        let env = with(&[("NETWORK", "ethereum"), ("COIN", "ETH"), token]);
        let message = error(preflight(&env));
        assert!(
            message.contains("TOKEN_ADDRESS") && message.contains("native coin"),
            "{message}"
        );
        assert!(preflight(&with(&[token])).is_ok());
    }

    #[test]
    fn network_and_coin_are_normalised() {
        let s = preflight(&with(&[("NETWORK", "BSC"), ("COIN", "usdt")])).unwrap();
        assert_eq!((s.network.as_str(), s.coin.as_str()), ("bsc", "USDT"));
    }

    #[test]
    fn the_env_file_is_read_literally_and_never_overrides() {
        let dir = std::env::temp_dir().join(format!("autopay-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".env");
        std::fs::write(
            &path,
            "# a comment\n\nexport A=1\nB = two words # note\nC=\"quoted # kept\"\nD='single $HOME'\n\
             E=$HOME\nKEPT=from file\nEMPTY=\n",
        )
        .unwrap();
        let mut env: Env = [("KEPT".to_string(), "from env".to_string())].into_iter().collect();
        load_env_file(&path, &mut env).unwrap();
        assert_eq!(env["A"], "1");
        assert_eq!(env["B"], "two words");
        assert_eq!(env["C"], "quoted # kept");
        assert_eq!(env["D"], "single $HOME");
        assert_eq!(env["E"], "$HOME");
        assert_eq!(env["KEPT"], "from env");
        assert_eq!(env["EMPTY"], "");

        let mut untouched = Env::new();
        load_env_file(&dir.join("missing.env"), &mut untouched).unwrap();
        assert!(untouched.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
