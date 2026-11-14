package autopay

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const (
	// ExitFatal is the exit code for a problem that will not fix itself.
	ExitFatal = 1
	// ExitManualCheck is the exit code when a human has to look at the wallet.
	ExitManualCheck = 3

	minute = time.Minute
	day    = 24 * time.Hour
	// minTimeLeft: an invoice with less time left than this is not paid, the payment could land after it expires.
	minTimeLeft = 5 * minute
	// depositCreditWait: a deposit not credited this long after the send needs a person to look at it.
	depositCreditWait = 2 * time.Hour
)

// Payer sends crypto from the wallet. One implementation per chain family (package payers).
type Payer interface {
	// Address is the wallet's own address.
	Address(ctx context.Context) (string, error)
	// Send sends amount (a decimal string) of coin to the address and returns the transaction id.
	Send(ctx context.Context, to, coin, amount string) (string, error)
}

// Checker is implemented by a Payer whose node is checked once, before any payment is created. Check returns
// a *ConfigError when the node can never be right (an EVM node of the other mainnet).
type Checker interface {
	Check(ctx context.Context) error
}

// OutcomeKind says what one cycle did.
type OutcomeKind int

// The outcomes of a cycle.
const (
	Idle OutcomeKind = iota
	Pending
	Sent
	DailyCap
	ManualCheck
	Retry
)

// Outcome is the result of one cycle. Reason is set for ManualCheck and Retry.
type Outcome struct {
	Kind   OutcomeKind
	Reason string
}

// FatalError is something that will not fix itself: bad configuration, bad key, corrupt state, rejected request.
type FatalError struct{ Message string }

func (e *FatalError) Error() string { return e.Message }

// Log writes one event line to stdout, prefixed by an ISO timestamp.
func Log(message string) {
	fmt.Printf("%s %s\n", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), message)
}

// Step runs one check-and-maybe-top-up cycle. It returns a *FatalError for anything that should stop the program.
func Step(
	ctx context.Context, cfg Config, api API, payer Payer, store *Store, now func() time.Time,
) (Outcome, error) {
	return StepWithLog(ctx, cfg, api, payer, store, now, Log)
}

// StepWithLog is Step with its log lines going to out.
func StepWithLog(
	ctx context.Context, cfg Config, api API, payer Payer, store *Store, now func() time.Time, out func(string),
) (Outcome, error) {
	outcome, err := cycle(ctx, cfg, api, payer, store, now, out)
	if err == nil {
		return outcome, nil
	}
	var stateErr *StateError
	if errors.As(err, &stateErr) {
		return Outcome{}, &FatalError{Message: stateErr.Message}
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return Outcome{}, err
	}
	switch {
	case apiErr.Transient:
		out("retry: " + apiErr.Message)
		return Outcome{Kind: Retry, Reason: apiErr.Message}, nil
	case apiErr.Status == 401:
		return Outcome{}, &FatalError{Message: "the API key was rejected (401)"}
	case apiErr.Status == 403:
		return Outcome{}, &FatalError{
			Message: "this key cannot top up (403): a reseller's customer key can't, use the account's own key",
		}
	}
	return Outcome{}, &FatalError{Message: apiErr.Message}
}

func cycle(
	ctx context.Context, cfg Config, api API, payer Payer, store *Store, now func() time.Time, out func(string),
) (Outcome, error) {
	state, err := store.Load()
	if err != nil {
		return Outcome{}, err
	}
	var open *Topup
	for i := range state.Topups {
		if state.Topups[i].Phase != "done" {
			open = &state.Topups[i]
			break
		}
	}

	if open != nil && open.Phase == "sending" {
		return manualCheck(out, "a send may or may not have gone out: check the wallet, then edit the state file"), nil
	}
	if open != nil && open.Phase == "sent" {
		return follow(ctx, api, state, store, open, now, out)
	}

	var topup *Topup
	if open != nil {
		// Created but not sent: the program stopped between the two. Never pay it with another wallet.
		if open.Network != cfg.Network || open.Coin != cfg.Coin {
			return Outcome{}, &FatalError{Message: fmt.Sprintf(
				"invoice %s waits for %s on %s, but the configuration says %s on %s: "+
					"set them back until it is done, or close it in the state file",
				open.ID, open.Coin, open.Network, cfg.Coin, cfg.Network)}
		}
		invoice, err := api.GetPayment(ctx, open.ID)
		if err != nil {
			return Outcome{}, err
		}
		switch invoice.Status {
		case "expired", "paid", "refunded":
			return Outcome{Kind: Idle}, finish(state, store, open, invoice.Status, out)
		}
		if invoice.Status != "waiting" || (open.ExpiresAt != nil && time.UnixMilli(*open.ExpiresAt).Sub(now()) < minTimeLeft) {
			out(fmt.Sprintf("waiting %s (%s)", open.ID, invoice.Status))
			return Outcome{Kind: Pending}, nil
		}
		topup = open
	} else {
		balance, err := api.Balance(ctx)
		if err != nil {
			return Outcome{}, err
		}
		if balance >= cfg.ThresholdUSD {
			out(fmt.Sprintf("balance %s >= threshold %s", formatNumber(balance), formatNumber(cfg.ThresholdUSD)))
			return Outcome{Kind: Idle}, nil
		}

		sentToday := sentInLastDay(state, now())
		if sentToday+float64(cfg.TopupUSD) > float64(cfg.MaxPerDayUSD) {
			out(fmt.Sprintf("daily cap reached (%s/%d USD in 24h)", formatNumber(sentToday), cfg.MaxPerDayUSD))
			return Outcome{Kind: DailyCap}, nil
		}

		created, err := createTopup(ctx, cfg, api, now())
		if err != nil {
			return Outcome{}, err
		}
		if cfg.DryRun {
			out(fmt.Sprintf("would send %s %s on %s to %s", created.AmountCrypto, created.Coin, created.Network, created.Address))
			return Outcome{Kind: Idle}, nil
		}
		state.Topups = append(state.Topups, created)
		topup = &state.Topups[len(state.Topups)-1]
		// A deposit has nothing to wait for: it goes straight to `sending`.
		if topup.Kind == "invoice" {
			if err := store.Save(state); err != nil {
				return Outcome{}, err
			}
		}
	}

	out(fmt.Sprintf("created %s %s: send %s %s on %s to %s",
		topup.Kind, topup.ID, topup.AmountCrypto, topup.Coin, topup.Network, topup.Address))
	return send(ctx, payer, state, store, topup, now, out)
}

// sentInLastDay adds up what went out in the last 24 hours.
func sentInLastDay(state *State, now time.Time) float64 {
	since := now.Add(-day).UnixMilli()
	var total float64
	for i := range state.Topups {
		if at, sent := sendTime(&state.Topups[i]); sent && at > since {
			total += state.Topups[i].AmountUSD
		}
	}
	return total
}

// sendTime says when money went out for this record, and whether it did. A record edited by hand after a
// manual check may lack sentAt: it still counts, dated by its creation, so the daily cap cannot be bypassed.
func sendTime(t *Topup) (int64, bool) {
	if t.SentAt != nil {
		return *t.SentAt, true
	}
	if t.Txid != nil || t.Phase == "sending" || t.Phase == "sent" {
		return t.CreatedAt, true
	}
	return 0, false
}

// createTopup asks the API for a payment and turns the answer into a state record (not saved yet).
func createTopup(ctx context.Context, cfg Config, api API, at time.Time) (Topup, error) {
	topup := Topup{
		Network: cfg.Network, Coin: cfg.Coin, AmountUSD: float64(cfg.TopupUSD), CreatedAt: at.UnixMilli(),
	}

	if cfg.Method.Kind == "deposit" {
		deposit, err := api.CreateDeposit(ctx, CreateRequest{Coin: cfg.Coin, Network: cfg.Network})
		if err != nil {
			return Topup{}, err
		}
		if deposit.Network != cfg.Network || !contains(deposit.Coins, cfg.Coin) {
			return Topup{}, &FatalError{Message: fmt.Sprintf("the API answered with %s on %s, not %s on %s",
				joinCoins(deposit.Coins), deposit.Network, cfg.Coin, cfg.Network)}
		}
		// A fixed deposit address is credited 1:1, so the dollars are the amount.
		topup.ID, topup.Kind = "deposit:pending", "deposit"
		topup.AmountCrypto = fmt.Sprint(cfg.TopupUSD)
		topup.Address = deposit.Address
		topup.Phase = "sending"
		return topup, nil
	}

	invoice, err := api.CreateInvoice(ctx, CreateRequest{
		AmountUSD: cfg.TopupUSD, Coin: cfg.Coin, Network: cfg.Network, RefundAddress: cfg.RefundAddress,
	})
	if err != nil {
		return Topup{}, err
	}
	// Never pay something that is not what was asked for.
	if invoice.Coin != cfg.Coin || invoice.Network != cfg.Network || invoice.AmountUSD != float64(cfg.TopupUSD) {
		return Topup{}, &FatalError{Message: fmt.Sprintf("the API answered with %s USD in %s on %s, not %d USD in %s on %s",
			formatNumber(invoice.AmountUSD), invoice.Coin, invoice.Network, cfg.TopupUSD, cfg.Coin, cfg.Network)}
	}
	topup.ID, topup.Kind = invoice.ID, "invoice"
	topup.AmountCrypto, topup.Address = invoice.AmountCrypto, invoice.Address
	topup.ExpiresAt = &invoice.ExpiresAt
	topup.Phase = "created"
	return topup, nil
}

// send is the one place money leaves the wallet. `sending` is on disk before the payer is called.
func send(
	ctx context.Context, payer Payer, state *State, store *Store, topup *Topup, now func() time.Time, out func(string),
) (Outcome, error) {
	topup.Phase = "sending"
	if err := store.Save(state); err != nil {
		return Outcome{}, err
	}

	// Once the payer is called the send must not be cut short by a shutdown signal: an interrupted
	// transaction is exactly the case the state file cannot answer.
	txid, err := payer.Send(context.WithoutCancel(ctx), topup.Address, topup.Coin, topup.AmountCrypto)
	if err != nil {
		// The record stays `sending`: we cannot know whether the transaction went out.
		return manualCheck(out, fmt.Sprintf(
			"the send failed (%v) but may have gone out: check the wallet, then edit the state file", err)), nil
	}

	// Logged before the save: if the save fails, the transaction id is still on screen.
	out("sent " + txid)
	sentAt := now().UnixMilli()
	topup.Phase, topup.Txid, topup.SentAt = "sent", &txid, &sentAt
	if topup.Kind == "deposit" {
		topup.ID = "deposit:" + txid
	}
	if err := store.Save(state); err != nil {
		return Outcome{}, err
	}
	return Outcome{Kind: Sent}, nil
}

// follow tracks a payment that was sent until the account is credited.
func follow(
	ctx context.Context, api API, state *State, store *Store, topup *Topup, now func() time.Time, out func(string),
) (Outcome, error) {
	if topup.Kind == "deposit" {
		deposit, err := api.Deposit(ctx, topup.Network)
		if err != nil {
			return Outcome{}, err
		}
		for _, d := range deposit.Deposits {
			if topup.Txid != nil && d.TxHash == *topup.Txid && d.Credited {
				return Outcome{Kind: Idle}, finish(state, store, topup, "credited", out)
			}
		}
		// A deposit is listed once its transaction is seen on chain. One still missing after hours was most
		// likely dropped, or went somewhere else: waiting longer will not tell.
		sentAt := topup.CreatedAt
		if topup.SentAt != nil {
			sentAt = *topup.SentAt
		}
		if now().Sub(time.UnixMilli(sentAt)) > depositCreditWait {
			txid := ""
			if topup.Txid != nil {
				txid = *topup.Txid
			}
			return manualCheck(out, fmt.Sprintf("deposit %s is not credited 2 hours after the send: "+
				"look the transaction up on chain, then edit the state file", txid)), nil
		}
		out(fmt.Sprintf("waiting %s (not credited yet)", topup.ID))
		return Outcome{Kind: Pending}, nil
	}

	invoice, err := api.GetPayment(ctx, topup.ID)
	if err != nil {
		return Outcome{}, err
	}
	switch invoice.Status {
	case "paid", "refunded":
		return Outcome{Kind: Idle}, finish(state, store, topup, invoice.Status, out)
	case "expired":
		// A payment that arrives after the invoice expired is still credited, so this may be fine.
		return manualCheck(out, fmt.Sprintf(
			"invoice %s expired after the send: check your balance and the wallet, then edit the state file", topup.ID)), nil
	}
	out(fmt.Sprintf("waiting %s (%s)", topup.ID, invoice.Status))
	return Outcome{Kind: Pending}, nil
}

func finish(state *State, store *Store, topup *Topup, result string, out func(string)) error {
	topup.Phase, topup.Result = "done", &result
	if err := store.Save(state); err != nil {
		return err
	}
	out(fmt.Sprintf("done %s (%s)", topup.ID, result))
	return nil
}

func manualCheck(out func(string), reason string) Outcome {
	out("MANUAL CHECK: " + reason)
	return Outcome{Kind: ManualCheck, Reason: reason}
}

func contains(list []string, item string) bool {
	for _, v := range list {
		if v == item {
			return true
		}
	}
	return false
}

func joinCoins(coins []string) string {
	text := ""
	for i, c := range coins {
		if i > 0 {
			text += "/"
		}
		text += c
	}
	return text
}

// WatchLoop runs `run` every interval() until it asks for a manual check (ExitManualCheck) or ctx is done
// (0). A Fatal error from run is returned to the caller. Retry outcomes just wait for the next tick.
func WatchLoop(
	ctx context.Context,
	run func(ctx context.Context) (Outcome, error),
	sleep func(ctx context.Context, d time.Duration),
	interval func() time.Duration,
) (int, error) {
	for ctx.Err() == nil {
		outcome, err := run(ctx)
		if err != nil {
			return ExitFatal, err
		}
		if outcome.Kind == ManualCheck {
			return ExitManualCheck, nil
		}
		sleep(ctx, interval())
	}
	return 0, nil
}

// Sleep waits for d, or until ctx is cancelled (a signal), whichever comes first.
func Sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}
