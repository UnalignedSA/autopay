//! Ethereum and BSC: the native coin, or an ERC-20 token.

use std::time::Duration;

use alloy::network::TransactionBuilder;
use alloy::primitives::{Address, B256, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::{TransactionReceipt, TransactionRequest};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;

use super::Payer;
use crate::amounts::to_base_units;
use crate::config::{ConfigError, native_coin};

sol! {
    #[sol(rpc)]
    interface Erc20 {
        /// No outputs on purpose: Ethereum USDT returns nothing, and decoding a missing bool would fail.
        /// Success is the receipt status instead.
        function transfer(address to, uint256 value);
        function decimals() external view returns (uint8);
    }
}

const NATIVE_DECIMALS: u32 = 18;
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(300);
const RECEIPT_POLL: Duration = Duration::from_millis(500);

fn token_table(network: &str, coin: &str) -> Option<&'static str> {
    match (network, coin) {
        ("ethereum", "USDT") => Some("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
        ("ethereum", "USDC") => Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        ("bsc", "USDT") => Some("0x55d398326f99059fF775485246999027B3197955"),
        ("bsc", "USDC") => Some("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"),
        _ => None,
    }
}

pub struct EvmOptions {
    pub rpc_url: String,
    pub private_key: String,
    pub network: String,
    /// Overrides the built-in token contract.
    pub token_address: Option<String>,
}

pub struct EvmPayer {
    signer: PrivateKeySigner,
    rpc_url: reqwest::Url,
    network: String,
    token_address: Option<String>,
}

impl EvmPayer {
    /// Reads the private key (hex, with or without 0x).
    pub fn new(opts: EvmOptions) -> Result<Self, ConfigError> {
        let key = opts.private_key.trim();
        let signer: PrivateKeySigner = key
            .strip_prefix("0x")
            .unwrap_or(key)
            .parse()
            .map_err(|_| ConfigError("EVM_PRIVATE_KEY is not a valid hex private key".into()))?;
        let rpc_url = opts
            .rpc_url
            .parse()
            .map_err(|_| ConfigError("EVM_RPC_URL is not a valid URL".into()))?;
        Ok(EvmPayer {
            signer,
            rpc_url,
            network: opts.network,
            token_address: opts.token_address,
        })
    }

    /// The token contract for a coin: `None` for the chain's native coin, an error for an unknown token.
    pub fn token_for(&self, coin: &str) -> anyhow::Result<Option<&str>> {
        if native_coin(&self.network) == Some(coin) {
            return Ok(None);
        }
        match self
            .token_address
            .as_deref()
            .or_else(|| token_table(&self.network, coin))
        {
            Some(token) => Ok(Some(token)),
            None => bail!(
                "no token contract known for {coin} on {}: set TOKEN_ADDRESS",
                self.network
            ),
        }
    }
}

/// An address in hex. A mixed-case address must carry a valid checksum (EIP-55), as wallets check.
fn parse_address(text: &str) -> anyhow::Result<Address> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    let mixed = digits.chars().any(|c| c.is_ascii_uppercase()) && digits.chars().any(|c| c.is_ascii_lowercase());
    let parsed = if mixed {
        Address::parse_checksummed(text, None).ok()
    } else {
        text.parse().ok()
    };
    parsed.ok_or_else(|| anyhow!("{text:?} is not an EVM address"))
}

#[async_trait]
impl Payer for EvmPayer {
    async fn address(&self) -> anyhow::Result<String> {
        Ok(self.signer.address().to_checksum(None))
    }

    /// Pays the native coin or a token with EIP-1559 fees (the chain id is read from the RPC), then waits for
    /// one confirmation. Fails if the receipt status is not 1.
    async fn send(&self, to: &str, coin: &str, amount: &str) -> anyhow::Result<String> {
        let recipient = parse_address(to)?;
        let token = self.token_for(coin)?;
        let provider = ProviderBuilder::new()
            .wallet(self.signer.clone())
            .connect_http(self.rpc_url.clone());

        let hash = match token {
            None => {
                let value = U256::from(to_base_units(amount, NATIVE_DECIMALS)?);
                let request = TransactionRequest::default().with_to(recipient).with_value(value);
                *provider
                    .send_transaction(request)
                    .await
                    .context("sending the transaction")?
                    .tx_hash()
            }
            Some(token) => {
                let contract = Erc20::new(parse_address(token)?, &provider);
                let decimals = contract
                    .decimals()
                    .call()
                    .await
                    .with_context(|| format!("reading decimals of {token}"))?;
                let units = U256::from(to_base_units(amount, decimals.into())?);
                *contract
                    .transfer(recipient, units)
                    .send()
                    .await
                    .context("sending the transaction")?
                    .tx_hash()
            }
        };
        let receipt = wait_for_receipt(&provider, hash).await?;
        if !receipt.status() {
            bail!("transaction {hash} reverted");
        }
        Ok(hash.to_string())
    }
}

/// Polls until the transaction is mined (one confirmation). RPC errors on the way are retried until the timeout:
/// the transaction is out, and only its receipt is missing.
async fn wait_for_receipt(provider: &impl Provider, hash: B256) -> anyhow::Result<TransactionReceipt> {
    let deadline = tokio::time::Instant::now() + RECEIPT_TIMEOUT;
    let mut last_error = None;
    loop {
        match provider.get_transaction_receipt(hash).await {
            Ok(Some(receipt)) => return Ok(receipt),
            Ok(None) => {}
            Err(err) => last_error = Some(err),
        }
        if tokio::time::Instant::now() >= deadline {
            let why = last_error.map(|e| format!(" (last error: {e})")).unwrap_or_default();
            bail!("no receipt for {hash} after {}s{why}", RECEIPT_TIMEOUT.as_secs());
        }
        tokio::time::sleep(RECEIPT_POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::sol_types::SolCall;

    const OVERRIDE: &str = "0x1111111111111111111111111111111111111111";

    fn payer(network: &str, token_address: Option<&str>) -> EvmPayer {
        EvmPayer::new(EvmOptions {
            rpc_url: "http://127.0.0.1:1".into(),
            private_key: format!("0x{}", "11".repeat(32)),
            network: network.into(),
            token_address: token_address.map(str::to_string),
        })
        .unwrap()
    }

    #[test]
    fn the_transfer_abi_has_no_outputs_ethereum_usdt_returns_nothing() {
        assert_eq!(Erc20::transferCall::SIGNATURE, "transfer(address,uint256)");
        // What Ethereum USDT answers: no data at all. With no outputs declared, that decodes fine.
        assert!(Erc20::transferCall::abi_decode_returns(&[]).is_ok());
        assert_eq!(
            payer("ethereum", Some(OVERRIDE)).token_for("USDT").unwrap(),
            Some(OVERRIDE)
        );
    }

    #[tokio::test]
    async fn the_address_is_derived_from_the_key() {
        let p = payer("bsc", None);
        let address = p.address().await.unwrap();
        assert_eq!(address, "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A");
        assert_eq!(
            p.token_for("USDC").unwrap(),
            Some("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d")
        );
        assert_eq!(p.token_for("BNB").unwrap(), None);
        assert!(
            p.token_for("DAI")
                .unwrap_err()
                .to_string()
                .contains("no token contract")
        );
    }

    #[test]
    fn a_native_coin_is_never_a_token_even_with_token_address_an_unknown_coin_fails() {
        assert_eq!(payer("ethereum", Some(OVERRIDE)).token_for("ETH").unwrap(), None);
        let plain = payer("ethereum", None);
        assert_eq!(plain.token_for("ETH").unwrap(), None);
        assert!(
            plain
                .token_for("DAI")
                .unwrap_err()
                .to_string()
                .contains("TOKEN_ADDRESS")
        );
    }

    #[test]
    fn addresses_are_checked() {
        assert!(parse_address("0xdAC17F958D2ee523a2206206994597C13D831ec7").is_ok());
        assert!(parse_address("0xdac17f958d2ee523a2206206994597c13d831ec7").is_ok());
        // One letter's case flipped: a typo the checksum catches.
        assert!(parse_address("0xDAC17F958D2ee523a2206206994597C13D831ec7").is_err());
        assert!(parse_address("0x1234").is_err());
    }

    #[tokio::test]
    async fn an_unreachable_rpc_fails_before_anything_is_sent() {
        let err = payer("ethereum", None).send(OVERRIDE, "ETH", "1").await.unwrap_err();
        assert!(format!("{err:#}").contains("sending the transaction"), "{err:#}");
    }
}
