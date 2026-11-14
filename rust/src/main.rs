//! `autopay once` | `autopay watch`: keeps an Unaligned balance topped up, in crypto.

mod amounts;
mod api;
mod config;
mod payers;
mod state;
mod step;
#[cfg(test)]
mod testing;

use std::cell::Cell;
use std::path::Path;
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use api::{Api, ApiError};
use config::{Config, ConfigError, Env, Settings};
use payers::Payer;
use state::StateStore;
use step::{EXIT_FATAL, EXIT_MANUAL_CHECK, Fatal, Outcome, log, step, watch_loop};

/// What a cycle needs, built once the API has answered.
struct Session {
    cfg: Config,
    api: Api,
    payer: Box<dyn Payer>,
    store: StateStore,
}

enum SetupError {
    Api(ApiError),
    Config(ConfigError),
    /// The wallet's node did not answer. Like the API being down, it is tried again on the next tick.
    WalletUnreachable(String),
}

/// Checks the wallet's node: a wrong node is fatal, one that does not answer is retried.
async fn check_wallet(payer: &dyn Payer) -> Result<(), SetupError> {
    match payer.check().await {
        Ok(()) => Ok(()),
        Err(err) => match err.downcast::<ConfigError>() {
            Ok(config) => Err(SetupError::Config(config)),
            Err(err) => Err(SetupError::WalletUnreachable(format!("{err:#}"))),
        },
    }
}

/// Asks the API for the payment methods, then builds the wallet. The environment was checked before.
async fn set_up(settings: &Settings, env: &Env) -> Result<Session, SetupError> {
    let methods = Api::new(&settings.api, None).methods().await.map_err(SetupError::Api)?;
    let mut cfg = config::load_config(env, &methods).map_err(SetupError::Config)?;
    let payer = payers::make_payer(&cfg, env).map_err(SetupError::Config)?;
    // Before any payment is created: an EVM node of the other mainnet stops the program here.
    check_wallet(payer.as_ref()).await?;
    // An incomplete payment goes back to the wallet itself unless told otherwise.
    let s = &mut cfg.settings;
    if s.refund_address.is_none() && matches!(s.network.as_str(), "ethereum" | "bsc" | "solana") {
        let address = payer
            .address()
            .await
            .map_err(|e| SetupError::Config(ConfigError(format!("{e:#}"))))?;
        s.refund_address = Some(address);
    }
    let api = Api::new(&cfg.settings.api, Some(&cfg.settings.key));
    let store = StateStore::new(&cfg.settings.state_file);
    Ok(Session { cfg, api, payer, store })
}

fn now_ms() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

/// One cycle. Set-up counts as part of it: if the API is down at start, `watch` tries again on the next tick.
async fn cycle(session: &mut Option<Session>, settings: &Settings, env: &Env) -> Result<Outcome, Fatal> {
    let session = match session {
        Some(session) => session,
        None => match set_up(settings, env).await {
            Ok(ready) => session.insert(ready),
            Err(SetupError::Api(err)) if err.transient => {
                log(&format!("retry: {err}"));
                return Ok(Outcome::Retry(err.message));
            }
            Err(SetupError::WalletUnreachable(reason)) => {
                log(&format!("retry: {reason}"));
                return Ok(Outcome::Retry(reason));
            }
            Err(SetupError::Api(err)) => return Err(Fatal(err.message)),
            Err(SetupError::Config(err)) => return Err(Fatal(err.0)),
        },
    };
    step(
        &session.cfg,
        &session.api,
        session.payer.as_ref(),
        &session.store,
        now_ms,
    )
    .await
}

/// Resolves when SIGINT (Ctrl-C) or SIGTERM arrives. A signal that came while a cycle was running is kept and
/// seen at the next wait, so a send under way is never cut short.
struct Shutdown {
    #[cfg(unix)]
    signals: [tokio::signal::unix::Signal; 2],
}

impl Shutdown {
    fn listen() -> std::io::Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Shutdown {
                signals: [signal(SignalKind::interrupt())?, signal(SignalKind::terminate())?],
            })
        }
        #[cfg(not(unix))]
        Ok(Shutdown {})
    }

    async fn wait(&mut self) {
        #[cfg(unix)]
        {
            let [interrupt, terminate] = &mut self.signals;
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
            }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn run(mode: &str, settings: &Settings, env: &Env) -> Result<i32, Fatal> {
    let mut session = None;
    if mode == "once" {
        let outcome = cycle(&mut session, settings, env).await?;
        return Ok(if matches!(outcome, Outcome::ManualCheck(_)) {
            EXIT_MANUAL_CHECK
        } else {
            0
        });
    }

    let mut shutdown = Shutdown::listen().map_err(|e| Fatal(format!("cannot listen for signals: {e}")))?;
    let stopping = Cell::new(false);
    watch_loop(
        async || cycle(&mut session, settings, env).await,
        async |interval| {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = shutdown.wait() => stopping.set(true),
            }
        },
        Duration::from_secs(settings.check_interval),
        || stopping.get(),
    )
    .await
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode != "once" && mode != "watch" {
        eprintln!("usage: autopay once | autopay watch");
        return ExitCode::from(EXIT_FATAL as u8);
    }

    // The real environment first; `.env` only fills in what is not set.
    let mut env: Env = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    // Nothing leaves the machine before the environment is checked.
    let checked = config::load_env_file(Path::new(".env"), &mut env).and_then(|()| config::preflight(&env));
    let code = match checked {
        Err(err) => Err(Fatal(err.0)),
        Ok(settings) => run(&mode, &settings, &env).await,
    };
    match code {
        Ok(code) => ExitCode::from(code as u8),
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::from(EXIT_FATAL as u8)
        }
    }
}
