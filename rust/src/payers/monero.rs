//! monero-wallet-rpc `transfer`. Digest auth is used only when a user is set.

use std::collections::HashMap;

use anyhow::{Context, bail};
use async_trait::async_trait;
use md5::{Digest, Md5};
use serde::Deserialize;

use super::{Payer, wallet_http};
use crate::amounts::to_base_units_u64;

const DECIMALS: u32 = 12;

pub struct MoneroPayer {
    url: String,
    user: String,
    password: String,
    http: reqwest::Client,
}

impl MoneroPayer {
    /// `user` and `password` may be empty: no authentication then.
    pub fn new(url: &str, user: &str, password: &str) -> Self {
        MoneroPayer {
            url: url.into(),
            user: user.into(),
            password: password.into(),
            http: wallet_http(),
        }
    }

    async fn post(&self, body: &str, authorization: Option<String>) -> anyhow::Result<reqwest::Response> {
        let mut request = self
            .http
            .post(&self.url)
            .header("content-type", "application/json")
            .body(body.to_string());
        if let Some(value) = authorization {
            request = request.header("authorization", value);
        }
        request.send().await.context("wallet RPC")
    }
}

#[derive(Deserialize)]
struct RpcAnswer {
    #[serde(default)]
    result: Option<TransferResult>,
    #[serde(default)]
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct TransferResult {
    #[serde(default)]
    tx_hash: Option<String>,
}

#[derive(Deserialize)]
struct RpcError {
    message: Option<String>,
}

#[async_trait]
impl Payer for MoneroPayer {
    async fn address(&self) -> anyhow::Result<String> {
        bail!("the wallet address is not used for this network")
    }

    async fn send(&self, to: &str, _coin: &str, amount: &str) -> anyhow::Result<String> {
        // Integer atomic units, written as an integer.
        let atomic = to_base_units_u64(amount, DECIMALS)?;
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "0",
            "method": "transfer",
            "params": { "destinations": [{ "amount": atomic, "address": to }], "priority": 0 },
        })
        .to_string();

        let mut res = self.post(&body, None).await?;
        let challenge = res
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(challenge) = challenge
            && res.status() == 401
            && !self.user.is_empty()
            && challenge.to_lowercase().starts_with("digest")
        {
            let url = reqwest::Url::parse(&self.url).context("MONERO_WALLET_RPC_URL")?;
            let uri = match url.query() {
                Some(query) => format!("{}?{query}", url.path()),
                None => url.path().to_string(),
            };
            let cnonce = hex::encode(rand::random::<[u8; 8]>());
            let header = digest_header(&challenge, &self.user, &self.password, "POST", &uri, &cnonce);
            res = self.post(&body, Some(header)).await?;
        }
        let status = res.status().as_u16();
        if status == 401 {
            bail!("wallet RPC refused the credentials");
        }
        let text = res.text().await.context("wallet RPC")?;
        let Ok(answer) = serde_json::from_str::<RpcAnswer>(&text) else {
            bail!("wallet RPC answered HTTP {status} with a body that is not JSON");
        };
        if let Some(error) = answer.error {
            bail!("wallet RPC error: {}", error.message.as_deref().unwrap_or("unknown"));
        }
        match answer.result.and_then(|r| r.tx_hash).filter(|h| !h.is_empty()) {
            Some(hash) => Ok(hash),
            None => bail!("wallet RPC returned no transaction hash"),
        }
    }
}

fn md5_hex(text: &str) -> String {
    hex::encode(Md5::digest(text.as_bytes()))
}

/// Reads the `key=value` pairs (quoted or not) of a `WWW-Authenticate: Digest ...` header.
fn parse_challenge(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = header.trim_start();
    if rest.len() >= 6 && rest[..6].eq_ignore_ascii_case("digest") {
        rest = &rest[6..];
    }
    loop {
        rest = rest.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim().to_string();
        rest = &rest[eq + 1..];
        let value = if let Some(quoted) = rest.strip_prefix('"') {
            let end = quoted.find('"').unwrap_or(quoted.len());
            let value = &quoted[..end];
            rest = quoted.get(end + 1..).unwrap_or("");
            value
        } else {
            let end = rest.find(|c: char| c == ',' || c.is_whitespace()).unwrap_or(rest.len());
            let value = &rest[..end];
            rest = &rest[end..];
            value
        };
        out.insert(key, value.to_string());
    }
    out
}

/// The `Authorization` header answering a Digest challenge (RFC 7616, MD5, qop=auth).
fn digest_header(challenge: &str, user: &str, password: &str, method: &str, uri: &str, cnonce: &str) -> String {
    let c = parse_challenge(challenge);
    let get = |k: &str| c.get(k).map(String::as_str).unwrap_or("");
    let (realm, nonce, nc) = (get("realm"), get("nonce"), "00000001");
    let ha1 = md5_hex(&format!("{user}:{realm}:{password}"));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let response = md5_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"));
    let mut header = format!(
        r#"Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", algorithm=MD5, qop=auth, nc={nc}, cnonce="{cnonce}", response="{response}""#
    );
    if let Some(opaque) = c.get("opaque") {
        header.push_str(&format!(r#", opaque="{opaque}""#));
    }
    header
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Reply, json, stub};

    #[tokio::test]
    async fn the_amount_is_an_integer_in_atomic_units_no_auth_without_a_user() {
        let s = stub(|_, _| json(200, r#"{"id":"0","jsonrpc":"2.0","result":{"tx_hash":"deadbeef"}}"#)).await;
        let txid = MoneroPayer::new(&format!("{}/json_rpc", s.url), "", "")
            .send("44Addr", "XMR", "1.5")
            .await;
        assert_eq!(txid.unwrap(), "deadbeef");
        let requests = s.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].header("authorization"), None);
        assert!(
            requests[0].body.contains(r#""amount":1500000000000"#),
            "{}",
            requests[0].body
        );
        let sent: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_eq!(sent["method"], "transfer");
        assert_eq!(
            sent["params"]["destinations"],
            serde_json::json!([{ "amount": 1500000000000_u64, "address": "44Addr" }])
        );
    }

    #[tokio::test]
    async fn digest_auth_answers_the_challenge_when_a_user_is_set() {
        let s = stub(|seen, _| {
            let challenge = || {
                Reply::Full(
                    401,
                    vec![(
                        "www-authenticate",
                        r#"Digest realm="wallet", qop="auth", nonce="n0nce", algorithm=MD5"#.into(),
                    )],
                    "{}".into(),
                )
            };
            let Some(auth) = seen.header("authorization") else {
                return challenge();
            };
            let got = parse_challenge(auth);
            let get = |k: &str| got.get(k).cloned().unwrap_or_default();
            let ha1 = md5_hex("alice:wallet:secret");
            let ha2 = md5_hex("POST:/json_rpc");
            let expected = md5_hex(&format!("{ha1}:n0nce:{}:{}:auth:{ha2}", get("nc"), get("cnonce")));
            if get("response") == expected && get("username") == "alice" && get("uri") == "/json_rpc" {
                json(200, r#"{"result":{"tx_hash":"cafe"}}"#)
            } else {
                challenge()
            }
        })
        .await;
        let payer = MoneroPayer::new(&format!("{}/json_rpc", s.url), "alice", "secret");
        assert_eq!(payer.send("44A", "XMR", "2").await.unwrap(), "cafe");
        assert_eq!(s.requests().len(), 2);
    }

    #[tokio::test]
    async fn a_non_json_error_page_is_reported_clearly() {
        let s = stub(|_, _| {
            Reply::Full(
                500,
                vec![("content-type", "text/html".into())],
                "<html>oops</html>".into(),
            )
        })
        .await;
        let err = MoneroPayer::new(&format!("{}/json_rpc", s.url), "", "")
            .send("44A", "XMR", "1")
            .await
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("HTTP 500") && message.contains("not JSON"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn an_amount_that_does_not_fit_64_bits_is_refused_before_any_call() {
        let s = stub(|_, _| json(200, r#"{"result":{"tx_hash":"x"}}"#)).await;
        let payer = MoneroPayer::new(&s.url, "", "");
        assert!(payer.send("44A", "XMR", "20000000").await.is_err());
        assert!(s.requests().is_empty());
    }

    #[test]
    fn the_challenge_parser_reads_quoted_and_bare_values() {
        let c = parse_challenge(r#"Digest realm="a, b", qop="auth", nonce=xyz, algorithm=MD5"#);
        assert_eq!(c["realm"], "a, b");
        assert_eq!(c["nonce"], "xyz");
        assert_eq!(c["algorithm"], "MD5");
    }
}
