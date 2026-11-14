// Command autopay keeps an Unaligned balance topped up: `autopay once` checks one time, `autopay watch`
// checks every CHECK_INTERVAL seconds until stopped.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"github.com/UnalignedSA/autopay/go/autopay"
	"github.com/UnalignedSA/autopay/go/autopay/payers"
)

// session is everything a cycle needs, built once the API answered.
type session struct {
	cfg   autopay.Config
	api   autopay.API
	payer autopay.Payer
	store *autopay.Store
}

func main() {
	os.Exit(run())
}

func run() int {
	// A .env file in the working directory fills in what the environment lacks; it never overrides.
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "error: cannot read .env: %v\n", err)
		return autopay.ExitFatal
	}
	if len(os.Args) != 2 || (os.Args[1] != "once" && os.Args[1] != "watch") {
		fmt.Fprintln(os.Stderr, "usage: autopay once | autopay watch")
		return autopay.ExitFatal
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var current *session
	// Set-up counts as part of a cycle: if the API is down at start, `watch` tries again on the next tick.
	cycle := func(ctx context.Context) (autopay.Outcome, error) {
		if current == nil {
			s, err := setUp(ctx, os.Getenv)
			var apiErr *autopay.APIError
			if errors.As(err, &apiErr) && apiErr.Transient {
				autopay.Log("retry: " + apiErr.Message)
				return autopay.Outcome{Kind: autopay.Retry, Reason: apiErr.Message}, nil
			}
			var unreachable *walletUnreachable
			if errors.As(err, &unreachable) {
				autopay.Log("retry: " + unreachable.Error())
				return autopay.Outcome{Kind: autopay.Retry, Reason: unreachable.Error()}, nil
			}
			if err != nil {
				return autopay.Outcome{}, err
			}
			current = s
		}
		return autopay.Step(ctx, current.cfg, current.api, current.payer, current.store, time.Now)
	}

	code, err := dispatch(ctx, os.Args[1], cycle, func() time.Duration {
		if current == nil {
			return time.Minute
		}
		return time.Duration(current.cfg.CheckInterval) * time.Second
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return autopay.ExitFatal
	}
	return code
}

func dispatch(
	ctx context.Context, mode string, cycle func(context.Context) (autopay.Outcome, error), interval func() time.Duration,
) (int, error) {
	if mode == "watch" {
		return autopay.WatchLoop(ctx, cycle, autopay.Sleep, interval)
	}
	outcome, err := cycle(ctx)
	if err != nil {
		return autopay.ExitFatal, err
	}
	if outcome.Kind == autopay.ManualCheck {
		return autopay.ExitManualCheck, nil
	}
	return 0, nil
}

// walletUnreachable: the wallet's node did not answer at start. Like the API being down, it is tried again on the
// next tick.
type walletUnreachable struct{ err error }

func (e *walletUnreachable) Error() string { return e.err.Error() }

// checkWallet checks the wallet's node, for the wallets that have one to check: a wrong node is fatal, one that
// does not answer is retried.
func checkWallet(ctx context.Context, payer autopay.Payer) error {
	checker, ok := payer.(autopay.Checker)
	if !ok {
		return nil
	}
	err := checker.Check(ctx)
	var configErr *autopay.ConfigError
	if err == nil || errors.As(err, &configErr) {
		return err
	}
	return &walletUnreachable{err}
}

// setUp checks the environment, then asks the API for the payment methods. Nothing leaves the machine before
// the checks pass.
func setUp(ctx context.Context, env autopay.Env) (*session, error) {
	if _, err := autopay.Preflight(env); err != nil {
		return nil, err
	}
	methods, err := autopay.NewAPI(autopay.APIBase(env), "").Methods(ctx)
	if err != nil {
		return nil, err
	}
	cfg, err := autopay.LoadConfig(env, methods)
	if err != nil {
		return nil, err
	}
	payer, err := payers.MakePayer(cfg.Network, cfg.TokenAddress, env)
	if err != nil {
		return nil, err
	}
	// Before any payment is created: an EVM node of the other mainnet stops the program here.
	if err := checkWallet(ctx, payer); err != nil {
		return nil, err
	}
	// An incomplete payment goes back to the wallet itself unless told otherwise.
	if cfg.RefundAddress == "" && (cfg.Network == "ethereum" || cfg.Network == "bsc" || cfg.Network == "solana") {
		if cfg.RefundAddress, err = payer.Address(ctx); err != nil {
			return nil, err
		}
	}
	return &session{cfg: cfg, api: autopay.NewAPI(cfg.API, cfg.Key), payer: payer, store: autopay.NewStore(cfg.StateFile)}, nil
}
