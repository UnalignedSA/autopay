package autopay

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	msMinute = int64(60_000)
	msHour   = 60 * msMinute
)

var now = time.UnixMilli(1_800_000_000_000)

func nowMs() int64 { return now.UnixMilli() }

// fakeAPI is an in-memory API. Every call is appended to calls, in order.
type fakeAPI struct {
	calls    []string
	created  []string // JSON bodies of the create requests
	balance  float64
	balErr   error
	statuses map[string]string
	next     any // Invoice or Deposit
	deposits []DepositEntry
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{balance: 3, statuses: map[string]string{}, next: invoice("inv-1")}
}

func (f *fakeAPI) Balance(context.Context) (float64, error) {
	f.calls = append(f.calls, "balance")
	return f.balance, f.balErr
}

func (f *fakeAPI) record(req CreateRequest) {
	f.calls = append(f.calls, "create")
	body, _ := json.Marshal(req)
	f.created = append(f.created, string(body))
}

func (f *fakeAPI) CreateInvoice(_ context.Context, req CreateRequest) (Invoice, error) {
	f.record(req)
	return f.next.(Invoice), nil
}

func (f *fakeAPI) CreateDeposit(_ context.Context, req CreateRequest) (Deposit, error) {
	f.record(req)
	return f.next.(Deposit), nil
}

func (f *fakeAPI) GetPayment(_ context.Context, id string) (Invoice, error) {
	f.calls = append(f.calls, "get "+id)
	inv := invoice(id)
	if status, ok := f.statuses[id]; ok {
		inv.Status = status
	}
	return inv, nil
}

func (f *fakeAPI) Deposit(_ context.Context, network string) (Deposit, error) {
	f.calls = append(f.calls, "deposit "+network)
	d := deposit()
	d.Deposits = f.deposits
	return d, nil
}

func (f *fakeAPI) called(call string) bool { return slices.Contains(f.calls, call) }

type sentPayment struct{ to, coin, amount string }

type fakePayer struct {
	sent    []sentPayment
	failure error
	// afterSend, when set, runs once the payment is made.
	afterSend func()
}

func (p *fakePayer) Address(context.Context) (string, error) { return "0xwallet", nil }

func (p *fakePayer) Send(_ context.Context, to, coin, amount string) (string, error) {
	if p.failure != nil {
		return "", p.failure
	}
	p.sent = append(p.sent, sentPayment{to, coin, amount})
	if p.afterSend != nil {
		p.afterSend()
	}
	return "0xtxid", nil
}

func invoice(id string) Invoice {
	return Invoice{
		Kind: "invoice", ID: id, Coin: "USDT", Network: "bsc", AmountUSD: 50, AmountCrypto: "50.00",
		Address: "0xinvoice", CreatedAt: nowMs(), ExpiresAt: nowMs() + 30*msMinute, Status: "waiting",
	}
}

func deposit() Deposit {
	return Deposit{Kind: "deposit", Network: "solana", Coins: []string{"USDT", "USDC"}, Address: "SoLaddress"}
}

// record builds a state record; modify may change it.
func record(modify func(*Topup)) Topup {
	t := Topup{
		ID: "inv-1", Kind: "invoice", Network: "bsc", Coin: "USDT", AmountUSD: 50, AmountCrypto: "50.00",
		Address: "0xinvoice", ExpiresAt: ptr(nowMs() + 30*msMinute), Phase: "created", CreatedAt: nowMs(),
	}
	if modify != nil {
		modify(&t)
	}
	return t
}

type harness struct {
	t     *testing.T
	path  string
	store *Store
	api   *fakeAPI
	payer *fakePayer
	lines []string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.json")
	return &harness{t: t, path: path, store: NewStore(path), api: newFakeAPI(), payer: &fakePayer{}}
}

func (h *harness) config(modify func(*Config)) Config {
	cfg := Config{
		Key: "key", API: "https://example.test/v1", Network: "bsc", Coin: "USDT",
		Method:       Method{Coin: "USDT", Network: "bsc", Kind: "invoice", MinUSD: 5, MaxUSD: ptr(50000.0)},
		ThresholdUSD: 10, TopupUSD: 50, MaxPerDayUSD: 100, CheckInterval: 60, StateFile: h.path,
	}
	if modify != nil {
		modify(&cfg)
	}
	return cfg
}

func (h *harness) save(topups ...Topup) {
	h.t.Helper()
	if err := h.store.Save(&State{Version: 1, Topups: topups}); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) topups() []Topup {
	h.t.Helper()
	state, err := h.store.Load()
	if err != nil {
		h.t.Fatal(err)
	}
	return state.Topups
}

func (h *harness) run(cfg Config) (Outcome, error) {
	return h.runAt(cfg, now)
}

func (h *harness) runAt(cfg Config, at time.Time) (Outcome, error) {
	return StepWithLog(context.Background(), cfg, h.api, h.payer, h.store, func() time.Time { return at },
		func(line string) { h.lines = append(h.lines, line) })
}

// mustRun runs one cycle and fails the test on an error.
func (h *harness) mustRun(cfg Config) Outcome {
	h.t.Helper()
	out, err := h.run(cfg)
	if err != nil {
		h.t.Fatalf("step: %v", err)
	}
	return out
}

func (h *harness) expect(out Outcome, kind OutcomeKind) {
	h.t.Helper()
	if out.Kind != kind {
		h.t.Fatalf("outcome = %v (%s), want %v", out.Kind, out.Reason, kind)
	}
}

func (h *harness) expectFatal(err error) *FatalError {
	h.t.Helper()
	var fatal *FatalError
	if !errors.As(err, &fatal) {
		h.t.Fatalf("expected a FatalError, got %v", err)
	}
	return fatal
}

func TestT1BalanceAboveTheThresholdDoesNothing(t *testing.T) {
	h := newHarness(t)
	h.api.balance = 20
	h.expect(h.mustRun(h.config(nil)), Idle)
	if !slices.Equal(h.api.calls, []string{"balance"}) || len(h.payer.sent) != 0 {
		t.Errorf("calls %v, sent %v", h.api.calls, h.payer.sent)
	}
}

func TestT2LowBalanceCreatesAnInvoiceAndSendsTheExactAmount(t *testing.T) {
	h := newHarness(t)
	h.expect(h.mustRun(h.config(nil)), Sent)
	if want := []string{`{"amount_usd":50,"coin":"USDT","network":"bsc"}`}; !slices.Equal(h.api.created, want) {
		t.Errorf("created %v, want %v", h.api.created, want)
	}
	if want := []sentPayment{{"0xinvoice", "USDT", "50.00"}}; !slices.Equal(h.payer.sent, want) {
		t.Errorf("sent %v, want %v", h.payer.sent, want)
	}
	rec := h.topups()[0]
	if rec.Phase != "sent" || rec.Txid == nil || *rec.Txid != "0xtxid" || rec.SentAt == nil || *rec.SentAt != nowMs() {
		t.Errorf("record = %+v", rec)
	}
}

func TestT2bTheRefundAddressIsPassedWhenConfigured(t *testing.T) {
	h := newHarness(t)
	h.mustRun(h.config(func(c *Config) { c.RefundAddress = "0xrefund" }))
	want := []string{`{"amount_usd":50,"coin":"USDT","network":"bsc","refund_address":"0xrefund"}`}
	if !slices.Equal(h.api.created, want) {
		t.Errorf("created %v, want %v", h.api.created, want)
	}
}

func TestT3ARecordInSendingNeedsAManualCheck(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.Phase = "sending" }))
	h.expect(h.mustRun(h.config(nil)), ManualCheck)
	if len(h.api.calls) != 0 || len(h.payer.sent) != 0 {
		t.Errorf("calls %v, sent %v", h.api.calls, h.payer.sent)
	}
}

func TestT4APaidInvoiceIsDoneAndTheNextCycleTopsUpAgain(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.Phase = "sent"; r.Txid = ptr("0xold"); r.SentAt = ptr(nowMs() - 3*msHour) }))
	h.api.statuses["inv-1"] = "paid"
	h.mustRun(h.config(nil))
	if rec := h.topups()[0]; rec.Phase != "done" || rec.Result == nil || *rec.Result != "paid" {
		t.Errorf("record = %+v", rec)
	}
	h.api.next = invoice("inv-2")
	h.expect(h.mustRun(h.config(nil)), Sent)
	if len(h.topups()) != 2 {
		t.Errorf("%d records, want 2", len(h.topups()))
	}
}

func TestT4bASentInvoiceStillConfirmingStaysPending(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.Phase = "sent"; r.Txid = ptr("0xold"); r.SentAt = ptr(nowMs()) }))
	h.api.statuses["inv-1"] = "confirming"
	h.expect(h.mustRun(h.config(nil)), Pending)
	if h.topups()[0].Phase != "sent" {
		t.Errorf("phase = %s", h.topups()[0].Phase)
	}
}

func TestT5ASentInvoiceThatExpiredNeedsAManualCheck(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.Phase = "sent"; r.Txid = ptr("0xold"); r.SentAt = ptr(nowMs()) }))
	h.api.statuses["inv-1"] = "expired"
	h.expect(h.mustRun(h.config(nil)), ManualCheck)
	if h.api.called("create") {
		t.Error("no payment may be created")
	}
}

func TestT6ACreatedInvoiceThatExpiredIsClosedWithoutSending(t *testing.T) {
	h := newHarness(t)
	h.save(record(nil))
	h.api.statuses["inv-1"] = "expired"
	h.mustRun(h.config(nil))
	if rec := h.topups()[0]; rec.Phase != "done" || rec.Result == nil || *rec.Result != "expired" {
		t.Errorf("record = %+v", rec)
	}
	if len(h.payer.sent) != 0 || h.api.called("create") {
		t.Errorf("sent %v, calls %v", h.payer.sent, h.api.calls)
	}
}

func TestT6bACreatedInvoiceThatIsStillOpenIsSentAfterARestart(t *testing.T) {
	h := newHarness(t)
	h.save(record(nil))
	h.expect(h.mustRun(h.config(nil)), Sent)
	if len(h.payer.sent) != 1 || h.api.called("create") {
		t.Errorf("sent %v, calls %v", h.payer.sent, h.api.calls)
	}
}

func TestT7TheDailyCapStopsATopupThatWouldExceedIt(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) {
		r.ID, r.Phase, r.Result, r.AmountUSD, r.SentAt = "old", "done", ptr("paid"), 45, ptr(nowMs()-2*msHour)
	}))
	cfg := h.config(func(c *Config) { c.TopupUSD, c.MaxPerDayUSD = 10, 50 })
	h.expect(h.mustRun(cfg), DailyCap)
	if h.api.called("create") {
		t.Error("no payment may be created")
	}
	if !slices.Contains(h.lines, "daily cap reached (45/50 USD in 24h)") {
		t.Errorf("log lines: %v", h.lines)
	}
}

func TestT7bSendsOlderThan24HoursDoNotCount(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) {
		r.ID, r.Phase, r.Result, r.AmountUSD, r.SentAt = "old", "done", ptr("paid"), 45, ptr(nowMs()-25*msHour)
	}))
	h.api.next = func() Invoice { i := invoice("inv-1"); i.AmountUSD, i.AmountCrypto = 10, "10.00"; return i }()
	h.expect(h.mustRun(h.config(func(c *Config) { c.TopupUSD, c.MaxPerDayUSD = 10, 50 })), Sent)
}

func depositConfig(h *harness) Config {
	return h.config(func(c *Config) {
		c.Network = "solana"
		c.Method = Method{Coin: "USDT", Network: "solana", Kind: "deposit", MinUSD: 1}
		c.TopupUSD = 10
	})
}

func TestT8ADepositMethodSendsTheAmountOneToOneAndWaitsForTheCredit(t *testing.T) {
	h := newHarness(t)
	cfg := depositConfig(h)
	h.api.next = deposit()
	h.expect(h.mustRun(cfg), Sent)
	if want := []string{`{"coin":"USDT","network":"solana"}`}; !slices.Equal(h.api.created, want) {
		t.Errorf("created %v, want %v", h.api.created, want)
	}
	if want := []sentPayment{{"SoLaddress", "USDT", "10"}}; !slices.Equal(h.payer.sent, want) {
		t.Errorf("sent %v, want %v", h.payer.sent, want)
	}
	if rec := h.topups()[0]; rec.ID != "deposit:0xtxid" || rec.Kind != "deposit" || rec.ExpiresAt != nil {
		t.Errorf("record = %+v", rec)
	}

	h.api.deposits = []DepositEntry{{TxHash: "0xtxid", Credited: false}}
	h.expect(h.mustRun(cfg), Pending)
	h.api.deposits = []DepositEntry{{TxHash: "0xtxid", Credited: true}}
	h.mustRun(cfg)
	if rec := h.topups()[0]; rec.Phase != "done" || rec.Result == nil || *rec.Result != "credited" {
		t.Errorf("record = %+v", rec)
	}
}

func TestT9DryRunCreatesThePaymentButSendsNothingAndLeavesTheStateFileUnchanged(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.ID, r.Phase, r.Result = "old", "done", ptr("paid") }))
	before, _ := os.ReadFile(h.path)
	h.expect(h.mustRun(h.config(func(c *Config) { c.DryRun = true })), Idle)
	if len(h.api.created) != 1 || len(h.payer.sent) != 0 {
		t.Errorf("created %v, sent %v", h.api.created, h.payer.sent)
	}
	if after, _ := os.ReadFile(h.path); string(after) != string(before) {
		t.Error("the state file changed")
	}
	if !slices.Contains(h.lines, "would send 50.00 USDT on bsc to 0xinvoice") {
		t.Errorf("log lines: %v", h.lines)
	}
}

func TestT10AFailingSendLeavesTheRecordInSendingAndAsksForAManualCheck(t *testing.T) {
	h := newHarness(t)
	h.payer.failure = errors.New("rpc down")
	h.expect(h.mustRun(h.config(nil)), ManualCheck)
	if h.topups()[0].Phase != "sending" {
		t.Errorf("phase = %s", h.topups()[0].Phase)
	}
	h.payer.failure = nil
	h.expect(h.mustRun(h.config(nil)), ManualCheck)
	if len(h.payer.sent) != 0 {
		t.Errorf("sent %v", h.payer.sent)
	}
}

func TestT11ACorruptStateFileIsFatalAndCallsNothing(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(h.path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := h.run(h.config(nil))
	h.expectFatal(err)
	if len(h.api.calls) != 0 {
		t.Errorf("calls %v", h.api.calls)
	}
}

func TestT12AnInvoiceAboutToExpireIsNotPaid(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.ExpiresAt = ptr(nowMs() + 4*msMinute) }))
	h.expect(h.mustRun(h.config(nil)), Pending)
	if len(h.payer.sent) != 0 {
		t.Errorf("sent %v", h.payer.sent)
	}
}

func TestT13A503IsARetryNotAFailure(t *testing.T) {
	h := newHarness(t)
	h.api.balErr = &APIError{Status: 503, Message: "unavailable", Transient: true}
	h.expect(h.mustRun(h.config(nil)), Retry)
}

func TestT14A401IsFatal(t *testing.T) {
	h := newHarness(t)
	h.api.balErr = &APIError{Status: 401, Code: "unauthorized", Message: "unauthorized"}
	_, err := h.run(h.config(nil))
	h.expectFatal(err)
}

func TestT14bA403IsFatalAndExplainsTheResellerCase(t *testing.T) {
	h := newHarness(t)
	h.api.balErr = &APIError{Status: 403, Code: "forbidden", Message: "forbidden"}
	_, err := h.run(h.config(nil))
	if fatal := h.expectFatal(err); !strings.Contains(fatal.Error(), "reseller") {
		t.Errorf("message = %q", fatal)
	}
}

func TestA429IsARetry(t *testing.T) {
	h := newHarness(t)
	h.api.balErr = &APIError{Status: 429, Message: "slow down", Transient: true}
	h.expect(h.mustRun(h.config(nil)), Retry)
}

func TestARefundedInvoiceIsDone(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) { r.Phase = "sent"; r.Txid = ptr("0xold"); r.SentAt = ptr(nowMs()) }))
	h.api.statuses["inv-1"] = "refunded"
	h.mustRun(h.config(nil))
	if rec := h.topups()[0]; rec.Phase != "done" || rec.Result == nil || *rec.Result != "refunded" {
		t.Errorf("record = %+v", rec)
	}
}

func TestACreatedInvoiceThatIsNotWaitingAnyMoreIsNotPaidAgain(t *testing.T) {
	h := newHarness(t)
	h.save(record(nil))
	h.api.statuses["inv-1"] = "confirming"
	h.expect(h.mustRun(h.config(nil)), Pending)
	if len(h.payer.sent) != 0 {
		t.Errorf("sent %v", h.payer.sent)
	}
}

func TestTheDailyCapCountsAHandEditedRecordThatHasNoSentAt(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) {
		r.ID, r.Phase, r.Result, r.AmountUSD = "old", "done", ptr("paid"), 45
		r.Txid, r.CreatedAt = ptr("0xold"), nowMs()-2*msHour
	}))
	h.expect(h.mustRun(h.config(func(c *Config) { c.TopupUSD, c.MaxPerDayUSD = 10, 50 })), DailyCap)
	if h.api.called("create") {
		t.Error("no payment may be created")
	}
}

func TestAnExpiredRecordThatNeverSentAnythingDoesNotCountTowardsTheCap(t *testing.T) {
	h := newHarness(t)
	h.save(record(func(r *Topup) {
		r.ID, r.Phase, r.Result, r.AmountUSD, r.CreatedAt = "old", "done", ptr("expired"), 45, nowMs()-2*msHour
	}))
	h.api.next = func() Invoice { i := invoice("inv-1"); i.AmountUSD, i.AmountCrypto = 10, "10.00"; return i }()
	h.expect(h.mustRun(h.config(func(c *Config) { c.TopupUSD, c.MaxPerDayUSD = 10, 50 })), Sent)
}

func TestAnInvoiceThatIsNotWhatWasAskedForIsNeverPaid(t *testing.T) {
	wrongs := map[string]func(*Invoice){
		"coin":    func(i *Invoice) { i.Coin = "USDC" },
		"network": func(i *Invoice) { i.Network = "ethereum" },
		"amount":  func(i *Invoice) { i.AmountUSD = 5000 },
	}
	h := newHarness(t)
	for name, wrong := range wrongs {
		inv := invoice("inv-x")
		wrong(&inv)
		h.api.next = inv
		_, err := h.run(h.config(nil))
		h.expectFatal(err)
		t.Log(name, "refused")
	}
	if len(h.payer.sent) != 0 {
		t.Errorf("sent %v", h.payer.sent)
	}
	if _, err := os.Stat(h.path); !os.IsNotExist(err) {
		t.Errorf("a state file was written: %v", err)
	}
}

func TestADepositOnTheWrongNetworkIsNeverPaid(t *testing.T) {
	h := newHarness(t)
	d := deposit()
	d.Coins = []string{"USDC"}
	h.api.next = d
	_, err := h.run(depositConfig(h))
	h.expectFatal(err)
	if len(h.payer.sent) != 0 {
		t.Errorf("sent %v", h.payer.sent)
	}
}

func TestAStateFileWithAMalformedRecordIsFatal(t *testing.T) {
	h := newHarness(t)
	good := map[string]any{
		"id": "inv-1", "kind": "invoice", "network": "bsc", "coin": "USDT", "amountUsd": 50,
		"amountCrypto": "50.00", "address": "0xinvoice", "expiresAt": nowMs(), "phase": "created",
		"txid": nil, "createdAt": nowMs(), "sentAt": nil, "result": nil,
	}
	override := func(key string, value any) map[string]any {
		rec := map[string]any{}
		for k, v := range good {
			rec[k] = v
		}
		if value == missing {
			delete(rec, key)
		} else {
			rec[key] = value
		}
		return rec
	}
	bad := []map[string]any{
		override("phase", "sendng"),
		override("network", 7),
		override("txid", 5),
		override("sentAt", "1793925000000"),
		override("expiresAt", "soon"),
		override("coin", missing),
		override("kind", "other"),
		override("amountUsd", "50"),
	}
	for _, rec := range bad {
		body, _ := json.Marshal(map[string]any{"version": 1, "topups": []any{rec}})
		if err := os.WriteFile(h.path, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := h.run(h.config(nil))
		h.expectFatal(err)
	}
	for _, text := range []string{`{"version":2,"topups":[]}`, `{"version":1}`, `[]`, `null`, ``} {
		if err := os.WriteFile(h.path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := h.run(h.config(nil))
		h.expectFatal(err)
	}
	if len(h.api.calls) != 0 {
		t.Errorf("calls %v", h.api.calls)
	}
}

// missing marks a field to delete in TestAStateFileWithAMalformedRecordIsFatal.
var missing = &struct{}{}

func TestWatchRunsCycleAfterCycleToleratesARetryAndStopsOnAManualCheck(t *testing.T) {
	outcomes := []Outcome{{Kind: Idle}, {Kind: Retry, Reason: "x"}, {Kind: Idle}, {Kind: ManualCheck, Reason: "y"}}
	runs := 0
	var sleeps []time.Duration
	code, err := WatchLoop(context.Background(),
		func(context.Context) (Outcome, error) { runs++; return outcomes[runs-1], nil },
		func(_ context.Context, d time.Duration) { sleeps = append(sleeps, d) },
		func() time.Duration { return 60 * time.Second })
	if err != nil || code != ExitManualCheck || runs != 4 {
		t.Fatalf("code %d, err %v, runs %d", code, err, runs)
	}
	if want := []time.Duration{60 * time.Second, 60 * time.Second, 60 * time.Second}; !slices.Equal(sleeps, want) {
		t.Errorf("sleeps %v", sleeps)
	}
}

func TestWatchStopsWith0WhenAskedTo(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runs := 0
	code, err := WatchLoop(ctx,
		func(context.Context) (Outcome, error) { runs++; return Outcome{Kind: Idle}, nil },
		func(context.Context, time.Duration) { cancel() },
		func() time.Duration { return 60 * time.Second })
	if err != nil || code != 0 || runs != 1 {
		t.Fatalf("code %d, err %v, runs %d", code, err, runs)
	}
}

func TestACreatedInvoiceForAnotherNetworkOrCoinThanTheConfigurationIsNeverPaid(t *testing.T) {
	for _, other := range []func(*Topup){
		func(r *Topup) { r.Network = "ethereum" },
		func(r *Topup) { r.Coin = "USDC" },
	} {
		h := newHarness(t)
		h.save(record(other))
		_, err := h.run(h.config(nil))
		if fatal := h.expectFatal(err); !strings.Contains(fatal.Message, "inv-1") {
			t.Errorf("message = %q", fatal.Message)
		}
		if len(h.api.calls) != 0 || len(h.payer.sent) != 0 || h.topups()[0].Phase != "created" {
			t.Errorf("calls %v, sent %v, record %+v", h.api.calls, h.payer.sent, h.topups()[0])
		}
	}
}

func TestTheTransactionIDIsLoggedEvenWhenTheSaveAfterTheSendFails(t *testing.T) {
	h := newHarness(t)
	// A directory where the temp file should go makes the save after the send fail.
	h.payer.afterSend = func() {
		if err := os.Mkdir(h.path+".tmp", 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.run(h.config(nil)); err == nil {
		t.Fatal("the save did not fail")
	}
	if len(h.payer.sent) != 1 || !slices.Contains(h.lines, "sent 0xtxid") {
		t.Errorf("sent %v, lines %v", h.payer.sent, h.lines)
	}
}

func TestADepositStillNotCredited2HoursAfterTheSendNeedsAManualCheck(t *testing.T) {
	h := newHarness(t)
	cfg := depositConfig(h)
	sent := func(sentAt int64) Topup {
		return record(func(r *Topup) {
			r.ID, r.Kind, r.Network, r.AmountCrypto, r.Address = "deposit:0xtxid", "deposit", "solana", "50", "SoLaddress"
			r.ExpiresAt, r.Phase, r.Txid, r.SentAt = nil, "sent", ptr("0xtxid"), ptr(sentAt)
		})
	}
	h.save(sent(nowMs() - 2*msHour))
	h.expect(h.mustRun(cfg), Pending)

	h.save(sent(nowMs() - 2*msHour - 1))
	out := h.mustRun(cfg)
	h.expect(out, ManualCheck)
	if !regexp.MustCompile(`0xtxid.*2 hours`).MatchString(out.Reason) || h.topups()[0].Phase != "sent" {
		t.Errorf("reason %q, record %+v", out.Reason, h.topups()[0])
	}

	// Credited late is still credited.
	h.api.deposits = []DepositEntry{{TxHash: "0xtxid", Credited: true}}
	h.expect(h.mustRun(cfg), Idle)
	if rec := h.topups()[0]; rec.Result == nil || *rec.Result != "credited" {
		t.Errorf("record = %+v", rec)
	}
}

func TestWatchLetsAFatalErrorThrough(t *testing.T) {
	_, err := WatchLoop(context.Background(),
		func(context.Context) (Outcome, error) { return Outcome{}, &FatalError{Message: "bad key"} },
		func(context.Context, time.Duration) {},
		func() time.Duration { return 60 * time.Second })
	var fatal *FatalError
	if !errors.As(err, &fatal) {
		t.Fatalf("err = %v", err)
	}
}

func TestSleepReturnsWhenTheContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { Sleep(ctx, time.Hour); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Sleep did not return after the cancel")
	}
}
