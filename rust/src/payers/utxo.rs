//! Bitcoin Core / Litecoin Core wallet over JSON-RPC (`sendtoaddress`), with basic auth.

use anyhow::{Context, bail};
use async_trait::async_trait;
use serde::Deserialize;

use super::{Payer, wallet_http};
use crate::amounts::to_base_units;

const DECIMALS: u32 = 8;

pub struct UtxoPayer {
    url: String,
    user: String,
    password: String,
    http: reqwest::Client,
}

impl UtxoPayer {
    pub fn new(url: &str, user: &str, password: &str) -> Self {
        UtxoPayer {
            url: url.into(),
            user: user.into(),
            password: password.into(),
            http: wallet_http(),
        }
    }
}

#[derive(Deserialize)]
struct RpcAnswer {
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcError {
    message: Option<String>,
}

/// The JSON-RPC body. The amount must reach the node as the exact decimal digits: a float could change them,
/// so the decimal string is spliced into the JSON text as a number literal. Leading zeros are not valid JSON
/// and are dropped.
fn request_body(to: &str, amount: &str) -> anyhow::Result<String> {
    // Checks that the string is a plain decimal with at most 8 decimals; the value itself is not used.
    to_base_units(amount, DECIMALS)?;
    let trimmed = amount.trim_start_matches('0');
    let literal = if trimmed.is_empty() || trimmed.starts_with('.') {
        format!("0{trimmed}")
    } else {
        trimmed.into()
    };
    let to = serde_json::to_string(to)?;
    Ok(format!(
        r#"{{"jsonrpc":"1.0","id":"autopay","method":"sendtoaddress","params":[{to},{literal}]}}"#
    ))
}

#[async_trait]
impl Payer for UtxoPayer {
    async fn address(&self) -> anyhow::Result<String> {
        bail!("the wallet address is not used for this network")
    }

    async fn send(&self, to: &str, _coin: &str, amount: &str) -> anyhow::Result<String> {
        let body = request_body(to, amount)?;
        let res = self
            .http
            .post(&self.url)
            .basic_auth(&self.user, Some(&self.password))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .context("wallet RPC")?;
        let status = res.status().as_u16();
        // Bitcoin Core answers errors with HTTP 500 and a JSON body, so read the body first.
        let text = res.text().await.context("wallet RPC")?;
        let Ok(answer) = serde_json::from_str::<RpcAnswer>(&text) else {
            bail!("wallet RPC answered HTTP {status}");
        };
        if let Some(error) = answer.error {
            bail!("wallet RPC error: {}", error.message.as_deref().unwrap_or("unknown"));
        }
        match answer.result {
            Some(serde_json::Value::String(txid)) => Ok(txid),
            _ => bail!("wallet RPC returned no transaction id"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{json, stub};

    #[tokio::test]
    async fn the_amount_is_spliced_into_the_json_as_a_raw_number_literal() {
        let s = stub(|_, _| json(200, r#"{"result":"abc123","error":null,"id":"autopay"}"#)).await;
        let payer = UtxoPayer::new(&s.url, "user", "pass");
        assert_eq!(
            payer.send("bcrt1qexample", "BTC", "0.00012345").await.unwrap(),
            "abc123"
        );
        let seen = &s.requests()[0];
        assert!(
            seen.body.contains(r#""params":["bcrt1qexample",0.00012345]"#),
            "{}",
            seen.body
        );
        assert_eq!(seen.header("authorization"), Some("Basic dXNlcjpwYXNz"));
    }

    #[tokio::test]
    async fn a_whole_amount_and_a_leading_zero_stay_valid_json_bad_amounts_are_refused() {
        let s = stub(|_, _| json(200, r#"{"result":"t","error":null}"#)).await;
        let payer = UtxoPayer::new(&s.url, "u", "p");
        payer.send("addr", "BTC", "50").await.unwrap();
        payer.send("addr", "BTC", "007.50").await.unwrap();
        payer.send("addr", "BTC", "000.5").await.unwrap();
        let requests = s.requests();
        assert!(requests[0].body.contains(r#""params":["addr",50]"#));
        assert!(requests[1].body.contains(r#""params":["addr",7.50]"#));
        assert!(requests[2].body.contains(r#""params":["addr",0.5]"#));
        for request in &requests {
            serde_json::from_str::<serde_json::Value>(&request.body).unwrap();
        }
        assert!(payer.send("addr", "BTC", "1e3").await.is_err());
        assert!(payer.send("addr", "BTC", "0.123456789").await.is_err());
        assert_eq!(s.requests().len(), 3);
    }

    #[tokio::test]
    async fn an_rpc_error_is_returned() {
        let s = stub(|_, _| {
            json(
                500,
                r#"{"result":null,"error":{"code":-6,"message":"Insufficient funds"}}"#,
            )
        })
        .await;
        let err = UtxoPayer::new(&s.url, "u", "p")
            .send("a", "BTC", "1")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Insufficient funds"), "{err}");
    }
}
