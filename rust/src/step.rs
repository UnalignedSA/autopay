//! `step()`: one check-and-maybe-top-up cycle, and the `watch` loop around it.

use std::time::Duration;

use thiserror::Error;

use crate::api::{ApiError, ApiLike, CreateRequest, MethodKind};
use crate::config::Config;
use crate::payers::Payer;
use crate::state::{Phase, State, StateError, StateStore, Topup, TopupKind};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// An invoice with less time left than this is not paid: the payment could land after it expires.
const MIN_TIME_LEFT: i64 = 5 * MINUTE;
/// A deposit not credited this long after the send needs a person to look at it.
const DEPOSIT_CREDIT_WAIT: i64 = 2 * HOUR;

pub const EXIT_FATAL: i32 = 1;
pub const EXIT_MANUAL_CHECK: i32 = 3;

/// What one cycle did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Idle,
    Pending,
    Sent,
    DailyCap,
    ManualCheck(String),
    Retry(String),
}

/// Something that will not fix itself: bad configuration, bad key, corrupt state, rejected request.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct Fatal(pub String);

/// Prints a log line on stdout, prefixed by an ISO timestamp.
pub fn log(line: &str) {
    println!(
        "{} {line}",
        humantime::format_rfc3339_millis(std::time::SystemTime::now())
    );
}

/// One check-and-maybe-top-up cycle, logging to stdout.
pub async fn step(
    cfg: &Config,
    api: &impl ApiLike,
    payer: &dyn Payer,
    store: &StateStore,
    now: impl Fn() -> i64,
) -> Result<Outcome, Fatal> {
    step_with_log(cfg, api, payer, store, now, &log).await
}

/// [`step`] with its log lines sent to `out`.
pub async fn step_with_log(
    cfg: &Config,
    api: &impl ApiLike,
    payer: &dyn Payer,
    store: &StateStore,
    now: impl Fn() -> i64,
    out: &dyn Fn(&str),
) -> Result<Outcome, Fatal> {
    match cycle(cfg, api, payer, store, &now, out).await {
        Ok(outcome) => Ok(outcome),
        Err(StepError::Fatal(fatal)) => Err(fatal),
        Err(StepError::State(err)) => Err(Fatal(err.0)),
        Err(StepError::Api(err)) if err.transient => {
            out(&format!("retry: {err}"));
            Ok(Outcome::Retry(err.message))
        }
        Err(StepError::Api(err)) => Err(Fatal(match err.status {
            401 => "the API key was rejected (401)".into(),
            403 => "this key cannot top up (403): a reseller's customer key can't, use the account's own key".into(),
            _ => err.message,
        })),
    }
}

/// What can stop a cycle: an API failure (transient or not), the state file, or a refusal to pay.
enum StepError {
    Api(ApiError),
    State(StateError),
    Fatal(Fatal),
}

impl From<ApiError> for StepError {
    fn from(err: ApiError) -> Self {
        StepError::Api(err)
    }
}

impl From<StateError> for StepError {
    fn from(err: StateError) -> Self {
        StepError::State(err)
    }
}

impl From<Fatal> for StepError {
    fn from(err: Fatal) -> Self {
        StepError::Fatal(err)
    }
}

async fn cycle(
    cfg: &Config,
    api: &impl ApiLike,
    payer: &dyn Payer,
    store: &StateStore,
    now: &impl Fn() -> i64,
    out: &dyn Fn(&str),
) -> Result<Outcome, StepError> {
    let s = &cfg.settings;
    let mut state = store.load()?;
    let open = state.topups.iter().position(|t| t.phase != Phase::Done);

    let index = match open {
        Some(i) if state.topups[i].phase == Phase::Sending => {
            return Ok(manual_check(
                out,
                "a send may or may not have gone out: check the wallet, then edit the state file".into(),
            ));
        }
        Some(i) if state.topups[i].phase == Phase::Sent => return follow(api, &mut state, store, i, now, out).await,
        Some(i) => {
            // Created but not sent: the program stopped between the two. Never pay it with another wallet.
            let topup = &state.topups[i];
            if topup.network != s.network || topup.coin != s.coin {
                return Err(Fatal(format!(
                    "invoice {} waits for {} on {}, but the configuration says {} on {}: \
                     set them back until it is done, or close it in the state file",
                    topup.id, topup.coin, topup.network, s.coin, s.network
                ))
                .into());
            }
            let invoice = api.get_payment(&topup.id).await?;
            if matches!(invoice.status.as_str(), "expired" | "paid" | "refunded") {
                finish(&mut state, store, i, &invoice.status, out)?;
                return Ok(Outcome::Idle);
            }
            let too_late = topup.expires_at.is_some_and(|at| at - now() < MIN_TIME_LEFT);
            if invoice.status != "waiting" || too_late {
                out(&format!("waiting {} ({})", topup.id, invoice.status));
                return Ok(Outcome::Pending);
            }
            i
        }
        None => {
            let balance = api.balance().await?;
            if balance >= s.threshold_usd {
                out(&format!("balance {balance} >= threshold {}", s.threshold_usd));
                return Ok(Outcome::Idle);
            }

            let since = now() - DAY;
            let sent_today: f64 = state
                .topups
                .iter()
                .filter(|t| send_time(t).is_some_and(|at| at > since))
                .map(|t| t.amount_usd)
                .sum();
            if sent_today + s.topup_usd as f64 > s.max_per_day_usd as f64 {
                out(&format!(
                    "daily cap reached ({sent_today}/{} USD in 24h)",
                    s.max_per_day_usd
                ));
                return Ok(Outcome::DailyCap);
            }

            let created = create_topup(cfg, api, now()).await?;
            if s.dry_run {
                let Topup {
                    amount_crypto,
                    coin,
                    network,
                    address,
                    ..
                } = &created;
                out(&format!("would send {amount_crypto} {coin} on {network} to {address}"));
                return Ok(Outcome::Idle);
            }
            let kind = created.kind;
            state.topups.push(created);
            // A deposit has nothing to wait for: it goes straight to `sending`.
            if kind == TopupKind::Invoice {
                store.save(&state)?;
            }
            state.topups.len() - 1
        }
    };

    let Topup {
        kind,
        id,
        amount_crypto,
        coin,
        network,
        address,
        ..
    } = &state.topups[index];
    out(&format!(
        "created {kind} {id}: send {amount_crypto} {coin} on {network} to {address}"
    ));
    send(payer, &mut state, store, index, now, out).await
}

/// When money went out for this record, or `None` if it did not. A record edited by hand after a manual check
/// may lack `sentAt`: it still counts, dated by its creation, so the daily cap cannot be bypassed.
fn send_time(t: &Topup) -> Option<i64> {
    t.sent_at
        .or_else(|| (t.txid.is_some() || matches!(t.phase, Phase::Sending | Phase::Sent)).then_some(t.created_at))
}

/// Asks the API for a payment and turns the answer into a state record (not saved yet).
async fn create_topup(cfg: &Config, api: &impl ApiLike, now: i64) -> Result<Topup, StepError> {
    let s = &cfg.settings;
    let mut request = CreateRequest {
        amount_usd: None,
        coin: s.coin.clone(),
        network: s.network.clone(),
        refund_address: None,
    };

    if cfg.method.kind == MethodKind::Deposit {
        let deposit = api.create_deposit(&request).await?;
        if deposit.network != s.network || !deposit.coins.contains(&s.coin) {
            return Err(Fatal(format!(
                "the API answered with {} on {}, not {} on {}",
                deposit.coins.join("/"),
                deposit.network,
                s.coin,
                s.network
            ))
            .into());
        }
        // A fixed deposit address is credited 1:1, so the dollars are the amount.
        return Ok(Topup {
            id: "deposit:pending".into(),
            kind: TopupKind::Deposit,
            network: s.network.clone(),
            coin: s.coin.clone(),
            amount_usd: s.topup_usd as f64,
            amount_crypto: s.topup_usd.to_string(),
            address: deposit.address,
            expires_at: None,
            phase: Phase::Sending,
            txid: None,
            created_at: now,
            sent_at: None,
            result: None,
        });
    }

    request.amount_usd = Some(s.topup_usd);
    request.refund_address = s.refund_address.clone();
    let invoice = api.create_invoice(&request).await?;
    // Never pay something that is not what was asked for.
    if invoice.coin != s.coin || invoice.network != s.network || invoice.amount_usd != s.topup_usd as f64 {
        return Err(Fatal(format!(
            "the API answered with {} USD in {} on {}, not {} USD in {} on {}",
            invoice.amount_usd, invoice.coin, invoice.network, s.topup_usd, s.coin, s.network
        ))
        .into());
    }
    Ok(Topup {
        id: invoice.id,
        kind: TopupKind::Invoice,
        network: s.network.clone(),
        coin: s.coin.clone(),
        amount_usd: s.topup_usd as f64,
        amount_crypto: invoice.amount_crypto,
        address: invoice.address,
        expires_at: Some(invoice.expires_at),
        phase: Phase::Created,
        txid: None,
        created_at: now,
        sent_at: None,
        result: None,
    })
}

/// The one place money leaves the wallet. `sending` is on disk before the payer is called.
async fn send(
    payer: &dyn Payer,
    state: &mut State,
    store: &StateStore,
    index: usize,
    now: &impl Fn() -> i64,
    out: &dyn Fn(&str),
) -> Result<Outcome, StepError> {
    state.topups[index].phase = Phase::Sending;
    store.save(state)?;

    let topup = &state.topups[index];
    let txid = match payer.send(&topup.address, &topup.coin, &topup.amount_crypto).await {
        Ok(txid) => txid,
        // The record stays `sending`: there is no knowing whether the transaction went out.
        Err(err) => {
            return Ok(manual_check(
                out,
                format!("the send failed ({err:#}) but may have gone out: check the wallet, then edit the state file"),
            ));
        }
    };

    // Logged before the save: if the save fails, the transaction id is still on screen.
    out(&format!("sent {txid}"));
    let topup = &mut state.topups[index];
    topup.phase = Phase::Sent;
    topup.sent_at = Some(now());
    if topup.kind == TopupKind::Deposit {
        topup.id = format!("deposit:{txid}");
    }
    topup.txid = Some(txid);
    store.save(state)?;
    Ok(Outcome::Sent)
}

/// Follows a payment that was sent until the account is credited.
async fn follow(
    api: &impl ApiLike,
    state: &mut State,
    store: &StateStore,
    index: usize,
    now: &impl Fn() -> i64,
    out: &dyn Fn(&str),
) -> Result<Outcome, StepError> {
    let topup = &state.topups[index];
    if topup.kind == TopupKind::Deposit {
        let deposit = api.deposit(&topup.network).await?;
        let seen = deposit
            .deposits
            .iter()
            .find(|d| Some(&d.tx_hash) == topup.txid.as_ref());
        let credited = seen.is_some_and(|d| d.credited);
        if credited {
            finish(state, store, index, "credited", out)?;
            return Ok(Outcome::Idle);
        }
        // A deposit is listed once its transaction is seen on chain. One still missing after hours was most
        // likely dropped, or went somewhere else: waiting longer will not tell.
        if now() - topup.sent_at.unwrap_or(topup.created_at) > DEPOSIT_CREDIT_WAIT {
            return Ok(manual_check(
                out,
                format!(
                    "deposit {} is not credited 2 hours after the send: look the transaction up on chain, \
                     then edit the state file",
                    topup.txid.as_deref().unwrap_or_default()
                ),
            ));
        }
        out(&format!("waiting {} (not credited yet)", topup.id));
        return Ok(Outcome::Pending);
    }

    let invoice = api.get_payment(&topup.id).await?;
    match invoice.status.as_str() {
        "paid" | "refunded" => {
            finish(state, store, index, &invoice.status, out)?;
            Ok(Outcome::Idle)
        }
        // A payment that arrives after the invoice expired is still credited, so this may be fine.
        "expired" => Ok(manual_check(
            out,
            format!(
                "invoice {} expired after the send: check your balance and the wallet, then edit the state file",
                topup.id
            ),
        )),
        status => {
            out(&format!("waiting {} ({status})", topup.id));
            Ok(Outcome::Pending)
        }
    }
}

fn finish(
    state: &mut State,
    store: &StateStore,
    index: usize,
    result: &str,
    out: &dyn Fn(&str),
) -> Result<(), StateError> {
    let topup = &mut state.topups[index];
    topup.phase = Phase::Done;
    topup.result = Some(result.into());
    let id = topup.id.clone();
    store.save(state)?;
    out(&format!("done {id} ({result})"));
    Ok(())
}

fn manual_check(out: &dyn Fn(&str), reason: String) -> Outcome {
    out(&format!("MANUAL CHECK: {reason}"));
    Outcome::ManualCheck(reason)
}

/// Runs `run` every `interval` until it asks for a manual check (exit 3) or `stopped()` is true (exit 0).
/// A Fatal error is returned to the caller. Retry outcomes just wait for the next tick.
pub async fn watch_loop(
    mut run: impl AsyncFnMut() -> Result<Outcome, Fatal>,
    mut sleep: impl AsyncFnMut(Duration),
    interval: Duration,
    stopped: impl Fn() -> bool,
) -> Result<i32, Fatal> {
    while !stopped() {
        if let Outcome::ManualCheck(_) = run().await? {
            return Ok(EXIT_MANUAL_CHECK);
        }
        sleep(interval).await;
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::api::{Deposit, DepositEntry, Invoice, PaymentMethod};
    use crate::config::Settings;
    use crate::state::tests::TempDir;

    const NOW: i64 = 1_800_000_000_000;

    enum Created {
        Invoice(Invoice),
        Deposit(Deposit),
    }

    struct FakeApi {
        calls: RefCell<Vec<String>>,
        created: RefCell<Vec<CreateRequest>>,
        balance: RefCell<Result<f64, ApiError>>,
        statuses: RefCell<HashMap<String, String>>,
        next: RefCell<Created>,
        deposits: RefCell<Vec<DepositEntry>>,
    }

    impl FakeApi {
        fn new() -> Self {
            FakeApi {
                calls: RefCell::default(),
                created: RefCell::default(),
                balance: RefCell::new(Ok(3.0)),
                statuses: RefCell::default(),
                next: RefCell::new(Created::Invoice(invoice("inv-1"))),
                deposits: RefCell::default(),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
        fn called(&self, name: &str) -> bool {
            self.calls.borrow().iter().any(|c| c == name)
        }
        fn status(&self, id: &str, status: &str) {
            self.statuses.borrow_mut().insert(id.into(), status.into());
        }
    }

    impl ApiLike for FakeApi {
        async fn balance(&self) -> Result<f64, ApiError> {
            self.calls.borrow_mut().push("balance".into());
            self.balance.borrow().clone()
        }
        async fn create_invoice(&self, request: &CreateRequest) -> Result<Invoice, ApiError> {
            self.calls.borrow_mut().push("create".into());
            self.created.borrow_mut().push(request.clone());
            match &*self.next.borrow() {
                Created::Invoice(invoice) => Ok(invoice.clone()),
                Created::Deposit(_) => panic!("asked for an invoice, the fake holds a deposit"),
            }
        }
        async fn create_deposit(&self, request: &CreateRequest) -> Result<Deposit, ApiError> {
            self.calls.borrow_mut().push("create".into());
            self.created.borrow_mut().push(request.clone());
            match &*self.next.borrow() {
                Created::Deposit(deposit) => Ok(deposit.clone()),
                Created::Invoice(_) => panic!("asked for a deposit, the fake holds an invoice"),
            }
        }
        async fn get_payment(&self, id: &str) -> Result<Invoice, ApiError> {
            self.calls.borrow_mut().push(format!("get {id}"));
            let status = self
                .statuses
                .borrow()
                .get(id)
                .cloned()
                .unwrap_or_else(|| "waiting".into());
            Ok(Invoice { status, ..invoice(id) })
        }
        async fn deposit(&self, network: &str) -> Result<Deposit, ApiError> {
            self.calls.borrow_mut().push(format!("deposit {network}"));
            Ok(Deposit {
                deposits: self.deposits.borrow().clone(),
                ..deposit()
            })
        }
    }

    #[derive(Default)]
    struct FakePayer {
        sent: Mutex<Vec<(String, String, String)>>,
        fail_with: Mutex<Option<String>>,
        /// After a payment, a directory is made at this path (to make the next save fail).
        block_after_send: Mutex<Option<std::path::PathBuf>>,
    }

    impl FakePayer {
        fn sent(&self) -> Vec<(String, String, String)> {
            self.sent.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Payer for FakePayer {
        async fn address(&self) -> anyhow::Result<String> {
            Ok("0xwallet".into())
        }
        async fn send(&self, to: &str, coin: &str, amount: &str) -> anyhow::Result<String> {
            if let Some(message) = self.fail_with.lock().unwrap().clone() {
                anyhow::bail!(message);
            }
            self.sent.lock().unwrap().push((to.into(), coin.into(), amount.into()));
            if let Some(path) = self.block_after_send.lock().unwrap().as_ref() {
                std::fs::create_dir(path).unwrap();
            }
            Ok("0xtxid".into())
        }
    }

    fn sent(to: &str, coin: &str, amount: &str) -> (String, String, String) {
        (to.into(), coin.into(), amount.into())
    }

    fn invoice(id: &str) -> Invoice {
        Invoice {
            id: id.into(),
            coin: "USDT".into(),
            network: "bsc".into(),
            amount_usd: 50.0,
            amount_crypto: "50.00".into(),
            address: "0xinvoice".into(),
            created_at: NOW,
            expires_at: NOW + 30 * MINUTE,
            status: "waiting".into(),
        }
    }

    fn deposit() -> Deposit {
        Deposit {
            network: "solana".into(),
            coins: vec!["USDT".into(), "USDC".into()],
            address: "SoLaddress".into(),
            deposits: vec![],
        }
    }

    fn record() -> Topup {
        Topup {
            id: "inv-1".into(),
            kind: TopupKind::Invoice,
            network: "bsc".into(),
            coin: "USDT".into(),
            amount_usd: 50.0,
            amount_crypto: "50.00".into(),
            address: "0xinvoice".into(),
            expires_at: Some(NOW + 30 * MINUTE),
            phase: Phase::Created,
            txid: None,
            created_at: NOW,
            sent_at: None,
            result: None,
        }
    }

    /// A record that went out and was paid, `ago` milliseconds back.
    fn paid(id: &str, amount_usd: f64, ago: i64) -> Topup {
        Topup {
            id: id.into(),
            phase: Phase::Done,
            result: Some("paid".into()),
            amount_usd,
            sent_at: Some(NOW - ago),
            ..record()
        }
    }

    struct World {
        dir: TempDir,
        store: StateStore,
        api: FakeApi,
        payer: FakePayer,
    }

    impl World {
        fn new() -> Self {
            let dir = TempDir::new();
            let store = StateStore::new(dir.0.join("state.json"));
            World {
                dir,
                store,
                api: FakeApi::new(),
                payer: FakePayer::default(),
            }
        }

        fn path(&self) -> std::path::PathBuf {
            self.dir.0.join("state.json")
        }

        fn config(&self) -> Config {
            Config {
                settings: Settings {
                    key: "key".into(),
                    api: "https://example.test/v1".into(),
                    network: "bsc".into(),
                    coin: "USDT".into(),
                    threshold_usd: 10.0,
                    topup_usd: 50,
                    max_per_day_usd: 100,
                    check_interval: 60,
                    dry_run: false,
                    refund_address: None,
                    state_file: self.path().to_string_lossy().into(),
                    token_address: None,
                },
                method: PaymentMethod {
                    coin: "USDT".into(),
                    network: "bsc".into(),
                    kind: MethodKind::Invoice,
                    min_usd: 5.0,
                    max_usd: Some(50000.0),
                },
            }
        }

        fn capped(&self, topup_usd: u64, max_per_day_usd: u64) -> Config {
            let mut cfg = self.config();
            cfg.settings.topup_usd = topup_usd;
            cfg.settings.max_per_day_usd = max_per_day_usd;
            cfg
        }

        fn solana(&self, topup_usd: u64) -> Config {
            let mut cfg = self.config();
            cfg.settings.network = "solana".into();
            cfg.settings.topup_usd = topup_usd;
            cfg.method = PaymentMethod {
                coin: "USDT".into(),
                network: "solana".into(),
                kind: MethodKind::Deposit,
                min_usd: 1.0,
                max_usd: None,
            };
            cfg
        }

        fn save(&self, topups: Vec<Topup>) {
            self.store.save(&State { version: 1, topups }).unwrap();
        }

        fn topups(&self) -> Vec<Topup> {
            self.store.load().unwrap().topups
        }

        async fn run(&self, cfg: &Config) -> Result<Outcome, Fatal> {
            step_with_log(cfg, &self.api, &self.payer, &self.store, || NOW, &|_| {}).await
        }

        async fn run_default(&self) -> Result<Outcome, Fatal> {
            self.run(&self.config()).await
        }
    }

    fn api_error(status: u16, transient: bool) -> ApiError {
        ApiError {
            status,
            code: None,
            message: format!("HTTP {status}"),
            transient,
        }
    }

    #[tokio::test]
    async fn t1_balance_above_the_threshold_does_nothing() {
        let w = World::new();
        *w.api.balance.borrow_mut() = Ok(20.0);
        assert_eq!(w.run_default().await, Ok(Outcome::Idle));
        assert_eq!(w.api.calls(), vec!["balance"]);
        assert!(w.payer.sent().is_empty());
    }

    #[tokio::test]
    async fn t2_low_balance_creates_an_invoice_and_sends_the_exact_amount() {
        let w = World::new();
        assert_eq!(w.run_default().await, Ok(Outcome::Sent));
        let expected = CreateRequest {
            amount_usd: Some(50),
            coin: "USDT".into(),
            network: "bsc".into(),
            refund_address: None,
        };
        assert_eq!(*w.api.created.borrow(), vec![expected]);
        assert_eq!(w.payer.sent(), vec![sent("0xinvoice", "USDT", "50.00")]);
        let rec = &w.topups()[0];
        assert_eq!(rec.phase, Phase::Sent);
        assert_eq!(rec.txid.as_deref(), Some("0xtxid"));
        assert_eq!(rec.sent_at, Some(NOW));
    }

    #[tokio::test]
    async fn t2b_the_refund_address_is_passed_when_configured() {
        let w = World::new();
        let mut cfg = w.config();
        cfg.settings.refund_address = Some("0xrefund".into());
        w.run(&cfg).await.unwrap();
        assert_eq!(w.api.created.borrow()[0].refund_address.as_deref(), Some("0xrefund"));
        let body = serde_json::to_value(&w.api.created.borrow()[0]).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "amount_usd": 50, "coin": "USDT", "network": "bsc", "refund_address": "0xrefund" })
        );
    }

    #[tokio::test]
    async fn t3_a_record_in_sending_needs_a_manual_check() {
        let w = World::new();
        w.save(vec![Topup {
            phase: Phase::Sending,
            ..record()
        }]);
        assert!(matches!(w.run_default().await, Ok(Outcome::ManualCheck(_))));
        assert!(w.api.calls().is_empty());
        assert!(w.payer.sent().is_empty());
    }

    #[tokio::test]
    async fn t4_a_paid_invoice_is_done_and_the_next_cycle_tops_up_again() {
        let w = World::new();
        w.save(vec![Topup {
            phase: Phase::Sent,
            txid: Some("0xold".into()),
            sent_at: Some(NOW - 3 * HOUR),
            ..record()
        }]);
        w.api.status("inv-1", "paid");
        w.run_default().await.unwrap();
        assert_eq!(w.topups()[0].phase, Phase::Done);
        assert_eq!(w.topups()[0].result.as_deref(), Some("paid"));
        *w.api.next.borrow_mut() = Created::Invoice(invoice("inv-2"));
        assert_eq!(w.run_default().await, Ok(Outcome::Sent));
        assert_eq!(w.topups().len(), 2);
    }

    #[tokio::test]
    async fn t4b_a_sent_invoice_still_confirming_stays_pending() {
        let w = World::new();
        w.save(vec![Topup {
            phase: Phase::Sent,
            txid: Some("0xold".into()),
            sent_at: Some(NOW),
            ..record()
        }]);
        w.api.status("inv-1", "confirming");
        assert_eq!(w.run_default().await, Ok(Outcome::Pending));
        assert_eq!(w.topups()[0].phase, Phase::Sent);
    }

    #[tokio::test]
    async fn t5_a_sent_invoice_that_expired_needs_a_manual_check() {
        let w = World::new();
        w.save(vec![Topup {
            phase: Phase::Sent,
            txid: Some("0xold".into()),
            sent_at: Some(NOW),
            ..record()
        }]);
        w.api.status("inv-1", "expired");
        assert!(matches!(w.run_default().await, Ok(Outcome::ManualCheck(_))));
        assert!(!w.api.called("create"));
    }

    #[tokio::test]
    async fn t6_a_created_invoice_that_expired_is_closed_without_sending() {
        let w = World::new();
        w.save(vec![record()]);
        w.api.status("inv-1", "expired");
        w.run_default().await.unwrap();
        assert_eq!(w.topups()[0].phase, Phase::Done);
        assert_eq!(w.topups()[0].result.as_deref(), Some("expired"));
        assert!(w.payer.sent().is_empty());
        assert!(!w.api.called("create"));
    }

    #[tokio::test]
    async fn t6b_a_created_invoice_that_is_still_open_is_sent_after_a_restart() {
        let w = World::new();
        w.save(vec![record()]);
        assert_eq!(w.run_default().await, Ok(Outcome::Sent));
        assert_eq!(w.payer.sent().len(), 1);
        assert!(!w.api.called("create"));
    }

    #[tokio::test]
    async fn t7_the_daily_cap_stops_a_topup_that_would_exceed_it() {
        let w = World::new();
        w.save(vec![paid("old", 45.0, 2 * HOUR)]);
        let lines = RefCell::new(Vec::<String>::new());
        let outcome = step_with_log(&w.capped(10, 50), &w.api, &w.payer, &w.store, || NOW, &|l| {
            lines.borrow_mut().push(l.into())
        })
        .await;
        assert_eq!(outcome, Ok(Outcome::DailyCap));
        assert!(!w.api.called("create"));
        assert_eq!(*lines.borrow(), vec!["daily cap reached (45/50 USD in 24h)"]);
    }

    #[tokio::test]
    async fn t7b_sends_older_than_24_hours_do_not_count() {
        let w = World::new();
        w.save(vec![paid("old", 45.0, 25 * HOUR)]);
        *w.api.next.borrow_mut() = Created::Invoice(Invoice {
            amount_usd: 10.0,
            amount_crypto: "10.00".into(),
            ..invoice("inv-1")
        });
        assert_eq!(w.run(&w.capped(10, 50)).await, Ok(Outcome::Sent));
    }

    #[tokio::test]
    async fn t8_a_deposit_method_sends_the_amount_1_to_1_and_waits_for_the_credit() {
        let w = World::new();
        let cfg = w.solana(10);
        *w.api.next.borrow_mut() = Created::Deposit(deposit());
        assert_eq!(w.run(&cfg).await, Ok(Outcome::Sent));
        let expected = CreateRequest {
            amount_usd: None,
            coin: "USDT".into(),
            network: "solana".into(),
            refund_address: None,
        };
        assert_eq!(*w.api.created.borrow(), vec![expected]);
        assert_eq!(w.payer.sent(), vec![sent("SoLaddress", "USDT", "10")]);
        assert_eq!(w.topups()[0].id, "deposit:0xtxid");
        assert_eq!(w.topups()[0].kind, TopupKind::Deposit);

        *w.api.deposits.borrow_mut() = vec![DepositEntry {
            tx_hash: "0xtxid".into(),
            credited: false,
        }];
        assert_eq!(w.run(&cfg).await, Ok(Outcome::Pending));
        *w.api.deposits.borrow_mut() = vec![DepositEntry {
            tx_hash: "0xtxid".into(),
            credited: true,
        }];
        w.run(&cfg).await.unwrap();
        assert_eq!(w.topups()[0].phase, Phase::Done);
        assert_eq!(w.topups()[0].result.as_deref(), Some("credited"));
    }

    #[tokio::test]
    async fn t9_dry_run_creates_the_payment_but_sends_nothing_and_leaves_the_state_file_unchanged() {
        let w = World::new();
        w.save(vec![paid("old", 50.0, 30 * HOUR)]);
        let before = std::fs::read_to_string(w.path()).unwrap();
        let mut cfg = w.config();
        cfg.settings.dry_run = true;
        let lines = RefCell::new(Vec::<String>::new());
        let outcome = step_with_log(&cfg, &w.api, &w.payer, &w.store, || NOW, &|l| {
            lines.borrow_mut().push(l.into())
        })
        .await;
        assert_eq!(outcome, Ok(Outcome::Idle));
        assert_eq!(w.api.created.borrow().len(), 1);
        assert!(w.payer.sent().is_empty());
        assert_eq!(std::fs::read_to_string(w.path()).unwrap(), before);
        assert!(
            lines
                .borrow()
                .iter()
                .any(|l| l == "would send 50.00 USDT on bsc to 0xinvoice")
        );
    }

    #[tokio::test]
    async fn t10_a_failing_send_leaves_the_record_in_sending_and_asks_for_a_manual_check() {
        let w = World::new();
        *w.payer.fail_with.lock().unwrap() = Some("rpc down".into());
        let outcome = w.run_default().await;
        let Ok(Outcome::ManualCheck(reason)) = outcome else {
            panic!("{outcome:?}")
        };
        assert!(reason.contains("rpc down"), "{reason}");
        assert_eq!(w.topups()[0].phase, Phase::Sending);
        *w.payer.fail_with.lock().unwrap() = None;
        assert!(matches!(w.run_default().await, Ok(Outcome::ManualCheck(_))));
        assert!(w.payer.sent().is_empty());
    }

    #[tokio::test]
    async fn t11_a_corrupt_state_file_is_fatal_and_calls_nothing() {
        let w = World::new();
        std::fs::write(w.path(), "{not json").unwrap();
        assert!(w.run_default().await.is_err());
        assert!(w.api.calls().is_empty());
    }

    #[tokio::test]
    async fn t12_an_invoice_about_to_expire_is_not_paid() {
        let w = World::new();
        w.save(vec![Topup {
            expires_at: Some(NOW + 4 * MINUTE),
            ..record()
        }]);
        assert_eq!(w.run_default().await, Ok(Outcome::Pending));
        assert!(w.payer.sent().is_empty());
    }

    #[tokio::test]
    async fn t13_a_503_is_a_retry_not_a_failure() {
        let w = World::new();
        *w.api.balance.borrow_mut() = Err(api_error(503, true));
        assert!(matches!(w.run_default().await, Ok(Outcome::Retry(_))));
    }

    #[tokio::test]
    async fn t14_a_401_is_fatal() {
        let w = World::new();
        *w.api.balance.borrow_mut() = Err(api_error(401, false));
        assert_eq!(
            w.run_default().await,
            Err(Fatal("the API key was rejected (401)".into()))
        );
    }

    #[tokio::test]
    async fn t14b_a_403_is_fatal_and_explains_the_reseller_case() {
        let w = World::new();
        *w.api.balance.borrow_mut() = Err(api_error(403, false));
        let Err(Fatal(message)) = w.run_default().await else {
            panic!("expected Fatal")
        };
        assert!(message.contains("reseller"), "{message}");
    }

    #[tokio::test]
    async fn a_429_is_a_retry() {
        let w = World::new();
        *w.api.balance.borrow_mut() = Err(api_error(429, true));
        assert!(matches!(w.run_default().await, Ok(Outcome::Retry(_))));
    }

    #[tokio::test]
    async fn another_4xx_is_fatal_with_the_api_message() {
        let w = World::new();
        *w.api.balance.borrow_mut() = Err(api_error(400, false));
        assert_eq!(w.run_default().await, Err(Fatal("HTTP 400".into())));
    }

    #[tokio::test]
    async fn a_refunded_invoice_is_done() {
        let w = World::new();
        w.save(vec![Topup {
            phase: Phase::Sent,
            txid: Some("0xold".into()),
            sent_at: Some(NOW),
            ..record()
        }]);
        w.api.status("inv-1", "refunded");
        w.run_default().await.unwrap();
        assert_eq!(w.topups()[0].phase, Phase::Done);
        assert_eq!(w.topups()[0].result.as_deref(), Some("refunded"));
    }

    #[tokio::test]
    async fn a_created_invoice_that_is_not_waiting_any_more_is_not_paid_again() {
        let w = World::new();
        w.save(vec![record()]);
        w.api.status("inv-1", "confirming");
        assert_eq!(w.run_default().await, Ok(Outcome::Pending));
        assert!(w.payer.sent().is_empty());
    }

    #[tokio::test]
    async fn the_daily_cap_counts_a_hand_edited_record_that_has_no_sent_at() {
        let w = World::new();
        w.save(vec![Topup {
            txid: Some("0xold".into()),
            sent_at: None,
            created_at: NOW - 2 * HOUR,
            ..paid("old", 45.0, 0)
        }]);
        assert_eq!(w.run(&w.capped(10, 50)).await, Ok(Outcome::DailyCap));
        assert!(!w.api.called("create"));
    }

    #[tokio::test]
    async fn an_expired_record_that_never_sent_anything_does_not_count_towards_the_cap() {
        let w = World::new();
        w.save(vec![Topup {
            id: "old".into(),
            phase: Phase::Done,
            result: Some("expired".into()),
            amount_usd: 45.0,
            created_at: NOW - 2 * HOUR,
            ..record()
        }]);
        *w.api.next.borrow_mut() = Created::Invoice(Invoice {
            amount_usd: 10.0,
            amount_crypto: "10.00".into(),
            ..invoice("inv-1")
        });
        assert_eq!(w.run(&w.capped(10, 50)).await, Ok(Outcome::Sent));
    }

    #[tokio::test]
    async fn an_invoice_that_is_not_what_was_asked_for_is_never_paid() {
        let w = World::new();
        let wrong = [
            Invoice {
                coin: "USDC".into(),
                ..invoice("inv-x")
            },
            Invoice {
                network: "ethereum".into(),
                ..invoice("inv-x")
            },
            Invoice {
                amount_usd: 5000.0,
                ..invoice("inv-x")
            },
        ];
        for invoice in wrong {
            *w.api.next.borrow_mut() = Created::Invoice(invoice.clone());
            assert!(w.run_default().await.is_err(), "{invoice:?}");
        }
        assert!(w.payer.sent().is_empty());
        assert!(!w.path().exists());
    }

    #[tokio::test]
    async fn a_deposit_on_the_wrong_network_or_coin_is_never_paid() {
        let w = World::new();
        for wrong in [
            Deposit {
                coins: vec!["USDC".into()],
                ..deposit()
            },
            Deposit {
                network: "ethereum".into(),
                ..deposit()
            },
        ] {
            *w.api.next.borrow_mut() = Created::Deposit(wrong);
            assert!(w.run(&w.solana(10)).await.is_err());
        }
        assert!(w.payer.sent().is_empty());
        assert!(!w.path().exists());
    }

    #[tokio::test]
    async fn a_state_file_with_a_malformed_record_is_fatal() {
        let w = World::new();
        let good = serde_json::to_value(record()).unwrap();
        for (field, value) in [
            ("phase", serde_json::json!("sendng")),
            ("network", serde_json::json!(7)),
            ("txid", serde_json::json!(5)),
            ("sentAt", serde_json::json!("1793925000000")),
            ("expiresAt", serde_json::json!("soon")),
            ("coin", serde_json::Value::Null),
        ] {
            let mut bad = good.clone();
            bad[field] = value;
            std::fs::write(
                w.path(),
                serde_json::json!({ "version": 1, "topups": [bad] }).to_string(),
            )
            .unwrap();
            assert!(w.run_default().await.is_err(), "{field}");
        }
        assert!(w.api.calls().is_empty());
    }

    #[tokio::test]
    async fn the_log_lines_follow_the_contract() {
        let w = World::new();
        let lines = RefCell::new(Vec::<String>::new());
        let out = |l: &str| lines.borrow_mut().push(l.into());
        step_with_log(&w.config(), &w.api, &w.payer, &w.store, || NOW, &out)
            .await
            .unwrap();
        w.api.status("inv-1", "confirming");
        step_with_log(&w.config(), &w.api, &w.payer, &w.store, || NOW, &out)
            .await
            .unwrap();
        w.api.status("inv-1", "paid");
        step_with_log(&w.config(), &w.api, &w.payer, &w.store, || NOW, &out)
            .await
            .unwrap();
        *w.api.balance.borrow_mut() = Ok(42.5);
        step_with_log(&w.config(), &w.api, &w.payer, &w.store, || NOW, &out)
            .await
            .unwrap();
        *w.api.balance.borrow_mut() = Err(api_error(503, true));
        step_with_log(&w.config(), &w.api, &w.payer, &w.store, || NOW, &out)
            .await
            .unwrap();
        assert_eq!(
            *lines.borrow(),
            vec![
                "created invoice inv-1: send 50.00 USDT on bsc to 0xinvoice",
                "sent 0xtxid",
                "waiting inv-1 (confirming)",
                "done inv-1 (paid)",
                "balance 42.5 >= threshold 10",
                "retry: HTTP 503",
            ]
        );
    }

    #[tokio::test]
    async fn watch_runs_cycle_after_cycle_tolerates_a_retry_and_stops_on_a_manual_check() {
        let outcomes = RefCell::new(vec![
            Outcome::Idle,
            Outcome::Retry("x".into()),
            Outcome::Idle,
            Outcome::ManualCheck("y".into()),
        ]);
        let runs = Cell::new(0);
        let sleeps = RefCell::new(Vec::new());
        let code = watch_loop(
            async || {
                runs.set(runs.get() + 1);
                Ok(outcomes.borrow_mut().remove(0))
            },
            async |d| sleeps.borrow_mut().push(d),
            Duration::from_secs(60),
            || false,
        )
        .await;
        assert_eq!(code, Ok(EXIT_MANUAL_CHECK));
        assert_eq!(runs.get(), 4);
        assert_eq!(*sleeps.borrow(), vec![Duration::from_secs(60); 3]);
    }

    #[tokio::test]
    async fn watch_stops_with_0_when_asked_to() {
        let stop = Cell::new(false);
        let runs = Cell::new(0);
        let code = watch_loop(
            async || {
                runs.set(runs.get() + 1);
                Ok(Outcome::Idle)
            },
            async |_| stop.set(true),
            Duration::from_secs(60),
            || stop.get(),
        )
        .await;
        assert_eq!(code, Ok(0));
        assert_eq!(runs.get(), 1);
    }

    #[tokio::test]
    async fn a_created_invoice_for_another_network_or_coin_than_the_configuration_is_never_paid() {
        for (network, coin) in [("ethereum", "USDT"), ("bsc", "USDC")] {
            let w = World::new();
            w.save(vec![Topup {
                network: network.into(),
                coin: coin.into(),
                ..record()
            }]);
            let err = w.run_default().await.unwrap_err();
            assert!(err.0.contains("inv-1"), "{err}");
            assert!(w.api.calls().is_empty());
            assert!(w.payer.sent().is_empty());
            assert_eq!(w.topups()[0].phase, Phase::Created);
        }
    }

    #[tokio::test]
    async fn the_transaction_id_is_logged_even_when_the_save_after_the_send_fails() {
        let w = World::new();
        // A directory where the temp file should go makes the save after the send fail.
        let mut tmp = w.path().into_os_string();
        tmp.push(".tmp");
        *w.payer.block_after_send.lock().unwrap() = Some(tmp.into());
        let lines = RefCell::new(Vec::new());
        let result = step_with_log(&w.config(), &w.api, &w.payer, &w.store, || NOW, &|line| {
            lines.borrow_mut().push(line.to_string())
        })
        .await;
        assert!(result.is_err());
        assert_eq!(w.payer.sent().len(), 1);
        assert!(
            lines.borrow().contains(&"sent 0xtxid".to_string()),
            "{:?}",
            lines.borrow()
        );
    }

    #[tokio::test]
    async fn a_deposit_still_not_credited_2_hours_after_the_send_needs_a_manual_check() {
        let w = World::new();
        let cfg = w.solana(50);
        let sent = |sent_at| Topup {
            id: "deposit:0xtxid".into(),
            kind: TopupKind::Deposit,
            network: "solana".into(),
            amount_crypto: "50".into(),
            address: "SoLaddress".into(),
            expires_at: None,
            phase: Phase::Sent,
            txid: Some("0xtxid".into()),
            sent_at: Some(sent_at),
            ..record()
        };
        w.save(vec![sent(NOW - 2 * HOUR)]);
        assert_eq!(w.run(&cfg).await, Ok(Outcome::Pending));

        w.save(vec![sent(NOW - 2 * HOUR - 1)]);
        match w.run(&cfg).await {
            Ok(Outcome::ManualCheck(reason)) => {
                assert!(reason.contains("0xtxid") && reason.contains("2 hours"), "{reason}")
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(w.topups()[0].phase, Phase::Sent);

        // Credited late is still credited.
        *w.api.deposits.borrow_mut() = vec![DepositEntry {
            tx_hash: "0xtxid".into(),
            credited: true,
        }];
        assert_eq!(w.run(&cfg).await, Ok(Outcome::Idle));
        assert_eq!(w.topups()[0].result.as_deref(), Some("credited"));
    }

    #[tokio::test]
    async fn watch_lets_a_fatal_error_through() {
        let code = watch_loop(
            async || Err(Fatal("bad key".into())),
            async |_| {},
            Duration::from_secs(60),
            || false,
        )
        .await;
        assert_eq!(code, Err(Fatal("bad key".into())));
    }
}
