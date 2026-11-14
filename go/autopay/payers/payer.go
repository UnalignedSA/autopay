// Package payers holds one wallet per chain family. Each implements autopay.Payer: it sends crypto and
// returns the transaction id.
package payers

import (
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/UnalignedCorp/unaligned-autopay/go/autopay"
)

// MakePayer builds the wallet for a network from the environment.
func MakePayer(network, tokenAddress string, env autopay.Env) (autopay.Payer, error) {
	if network == "tron" {
		return nil, &autopay.ConfigError{Message: autopay.TronMessage}
	}
	vars, known := autopay.WalletVars[network]
	if !known {
		return nil, &autopay.ConfigError{Message: "no wallet for network " + network}
	}
	// The variables each network needs are listed once, in the autopay package.
	for _, name := range vars {
		if env(name) == "" {
			return nil, &autopay.ConfigError{Message: name + " is required"}
		}
	}
	switch network {
	case "ethereum", "bsc":
		return NewEvmPayer(EvmOptions{
			RPCURL: env("EVM_RPC_URL"), PrivateKey: env("EVM_PRIVATE_KEY"), Network: network, TokenAddress: tokenAddress,
		})
	case "solana":
		return NewSolanaPayer(env("SOLANA_RPC_URL"), env("SOLANA_PRIVATE_KEY"), tokenAddress)
	case "monero":
		return NewMoneroPayer(env("MONERO_WALLET_RPC_URL"), env("MONERO_WALLET_RPC_USER"), env("MONERO_WALLET_RPC_PASSWORD")), nil
	default: // bitcoin, litecoin
		return NewUtxoPayer(env("WALLET_RPC_URL"), env("WALLET_RPC_USER"), env("WALLET_RPC_PASSWORD")), nil
	}
}

// walletHTTP is the HTTP client for the wallet RPCs. Only connecting has a time limit: a wallet can take its time
// to build and sign a transfer (Monero especially), and cutting the send short would leave it in doubt.
func walletHTTP() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 30 * time.Second}).DialContext
	return &http.Client{Transport: transport}
}

// errNoAddress is what the wallets without a default refund address answer to Address.
var errNoAddress = errors.New("the wallet address is not used for this network")
