//! The Unaligned API calls.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const TIMEOUT: Duration = Duration::from_secs(30);

/// One entry of `GET /payments/methods`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PaymentMethod {
    pub coin: String,
    pub network: String,
    pub kind: MethodKind,
    pub min_usd: f64,
    pub max_usd: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MethodKind {
    /// A one-off address with an amount and an expiry.
    Invoice,
    /// The account's fixed deposit address, credited 1:1.
    Deposit,
}

/// A payment to make to a one-off address.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invoice {
    pub id: String,
    pub coin: String,
    pub network: String,
    pub amount_usd: f64,
    pub amount_crypto: String,
    pub address: String,
    pub created_at: i64,
    pub expires_at: i64,
    /// waiting, confirming, partial, paid, expired or refunded
    pub status: String,
}

/// The account's fixed deposit address on a network, with what arrived on it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Deposit {
    pub network: String,
    pub coins: Vec<String>,
    pub address: String,
    pub deposits: Vec<DepositEntry>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositEntry {
    pub tx_hash: String,
    pub credited: bool,
}

/// The body of `POST /payments`. A deposit method leaves `amount_usd` out.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_usd: Option<u64>,
    pub coin: String,
    pub network: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refund_address: Option<String>,
}

#[derive(Debug, Clone, Error)]
#[error("{message}")]
pub struct ApiError {
    /// The HTTP status, 0 for a network error.
    pub status: u16,
    pub code: Option<String>,
    pub message: String,
    /// True for failures that may go away by themselves: network errors, unreadable answers, 5xx and 429.
    pub transient: bool,
}

/// The part of the API that `step` uses. [`Api`] implements it; tests use a fake.
pub trait ApiLike {
    async fn balance(&self) -> Result<f64, ApiError>;
    /// `POST /payments` with an amount: 201 with an invoice.
    async fn create_invoice(&self, request: &CreateRequest) -> Result<Invoice, ApiError>;
    /// `POST /payments` without an amount: 200 with the account's fixed deposit address.
    async fn create_deposit(&self, request: &CreateRequest) -> Result<Deposit, ApiError>;
    async fn get_payment(&self, id: &str) -> Result<Invoice, ApiError>;
    async fn deposit(&self, network: &str) -> Result<Deposit, ApiError>;
}

/// The Unaligned API over HTTP.
pub struct Api {
    base: String,
    /// `None` for the public calls only.
    key: Option<String>,
    http: reqwest::Client,
}

impl Api {
    pub fn new(base: &str, key: Option<&str>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("HTTP client");
        Api {
            base: base.to_string(),
            key: key.map(str::to_string),
            http,
        }
    }

    /// Public: sent without the key.
    pub async fn methods(&self) -> Result<Vec<PaymentMethod>, ApiError> {
        self.request(reqwest::Method::GET, "/payments/methods", None::<&()>, false)
            .await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&impl Serialize>,
        auth: bool,
    ) -> Result<T, ApiError> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.base))
            .header("content-type", "application/json");
        if auth && let Some(key) = &self.key {
            request = request.bearer_auth(key);
        }
        if let Some(body) = body {
            request = request.body(serde_json::to_string(body).expect("request body"));
        }
        let res = request.send().await.map_err(|err| ApiError {
            status: 0,
            code: None,
            message: format!("network error: {}", error_chain(&err)),
            transient: true,
        })?;

        let status = res.status();
        if status.is_success() {
            // A body that was cut off, is not JSON or has the wrong shape (even `null`) is a glitch, never zero
            // values: try again later.
            let unreadable = |why: String| ApiError {
                status: status.as_u16(),
                code: None,
                message: format!("{method} {path}: unreadable response: {why}"),
                transient: true,
            };
            let bytes = res.bytes().await.map_err(|err| unreadable(error_chain(&err)))?;
            return serde_json::from_slice(&bytes).map_err(|err| unreadable(err.to_string()));
        }

        #[derive(Deserialize)]
        struct ErrorBody {
            error: Option<ErrorDetail>,
        }
        #[derive(Deserialize)]
        struct ErrorDetail {
            code: Option<String>,
            message: Option<String>,
        }
        let detail = res.json::<ErrorBody>().await.ok().and_then(|b| b.error);
        let code = detail.as_ref().and_then(|d| d.code.clone());
        let message = detail
            .and_then(|d| d.message)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or_default().to_string());
        let parts = [
            format!("{method} {path}:"),
            status.as_u16().to_string(),
            code.clone().unwrap_or_default(),
            message,
        ];
        let text = parts
            .iter()
            .filter(|p| !p.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        Err(ApiError {
            status: status.as_u16(),
            code,
            message: text,
            // 429 means slow down, not give up.
            transient: status.is_server_error() || status.as_u16() == 429,
        })
    }
}

impl ApiLike for Api {
    async fn balance(&self) -> Result<f64, ApiError> {
        #[derive(Deserialize)]
        struct Balance {
            balance: f64,
        }
        let body: Balance = self
            .request(reqwest::Method::GET, "/balance", None::<&()>, true)
            .await?;
        Ok(body.balance)
    }

    async fn create_invoice(&self, request: &CreateRequest) -> Result<Invoice, ApiError> {
        self.request(reqwest::Method::POST, "/payments", Some(request), true)
            .await
    }

    async fn create_deposit(&self, request: &CreateRequest) -> Result<Deposit, ApiError> {
        self.request(reqwest::Method::POST, "/payments", Some(request), true)
            .await
    }

    async fn get_payment(&self, id: &str) -> Result<Invoice, ApiError> {
        let path = format!("/payments/{}", encode_component(id));
        self.request(reqwest::Method::GET, &path, None::<&()>, true).await
    }

    async fn deposit(&self, network: &str) -> Result<Deposit, ApiError> {
        let path = format!("/payments/deposit/{}", encode_component(network));
        self.request(reqwest::Method::GET, &path, None::<&()>, true).await
    }
}

/// Percent-encodes a path segment, like JavaScript's `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// An error and its causes, on one line.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        text.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Reply, json, stub};

    async fn server() -> crate::testing::Stub {
        stub(|seen, _| match seen.path.as_str() {
            p if p.ends_with("/garbage") => json(200, "<html>"),
            p if p.ends_with("/null") => json(200, "null"),
            // Promises more than it sends, then drops the connection.
            p if p.ends_with("/cut") => Reply::Raw("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\n{\"balance\"".into()),
            "/balance" => json(200, r#"{"balance": 12.5}"#),
            "/payments/methods" => json(200, "[]"),
            p if p.ends_with("/limited") => json(429, r#"{"error":{"code":"rate_limited","message":"slow"}}"#),
            p if p.ends_with("/down") => Reply::Full(503, vec![], "<html>down</html>".into()),
            _ => json(400, r#"{"error":{"code":"invalid_input","message":"nope"}}"#),
        })
        .await
    }

    #[tokio::test]
    async fn balance_sends_the_key_as_a_bearer_token() {
        let s = server().await;
        assert_eq!(Api::new(&s.url, Some("secret")).balance().await.unwrap(), 12.5);
        assert_eq!(s.requests()[0].header("authorization"), Some("Bearer secret"));
    }

    #[tokio::test]
    async fn methods_is_public_no_authorization_header() {
        let s = server().await;
        Api::new(&s.url, Some("secret")).methods().await.unwrap();
        assert_eq!(s.requests()[0].header("authorization"), None);
    }

    #[tokio::test]
    async fn a_400_carries_the_api_error_code_and_is_not_transient() {
        let s = server().await;
        let err = Api::new(&s.url, Some("k")).deposit("x").await.unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.code.as_deref(), Some("invalid_input"));
        assert!(!err.transient);
        assert!(err.message.contains("nope"), "{}", err.message);
        assert_eq!(err.message, "GET /payments/deposit/x: 400 invalid_input nope");
    }

    #[tokio::test]
    async fn a_429_is_transient() {
        let s = server().await;
        let err = Api::new(&s.url, Some("k")).get_payment("limited").await.unwrap_err();
        assert_eq!(err.status, 429);
        assert!(err.transient);
    }

    #[tokio::test]
    async fn a_5xx_without_json_keeps_the_status_text_and_is_transient() {
        let s = server().await;
        let err = Api::new(&s.url, Some("k")).get_payment("down").await.unwrap_err();
        assert_eq!(err.status, 503);
        assert!(err.transient);
        assert_eq!(err.message, "GET /payments/down: 503 Service Unavailable");
    }

    #[tokio::test]
    async fn a_non_json_cut_off_or_wrong_shaped_200_body_is_a_transient_error() {
        let s = server().await;
        for id in ["garbage", "cut", "null"] {
            let err = Api::new(&s.url, Some("k")).get_payment(id).await.unwrap_err();
            assert!(err.transient, "{id}: {}", err.message);
        }
    }

    #[tokio::test]
    async fn a_null_balance_is_a_transient_error_never_zero() {
        let s = stub(|_, _| json(200, "null")).await;
        assert!(Api::new(&s.url, Some("k")).balance().await.unwrap_err().transient);
    }

    #[tokio::test]
    async fn a_refused_connection_is_a_transient_error() {
        let err = Api::new("http://127.0.0.1:1", Some("k")).balance().await.unwrap_err();
        assert!(err.transient);
        assert!(err.message.starts_with("network error: "), "{}", err.message);
    }

    #[tokio::test]
    async fn the_create_body_leaves_out_what_is_not_set() {
        let s = stub(|_, _| json(400, "{}")).await;
        let api = Api::new(&s.url, Some("k"));
        let request = CreateRequest {
            amount_usd: None,
            coin: "USDT".into(),
            network: "solana".into(),
            refund_address: None,
        };
        let _ = api.create_deposit(&request).await;
        assert_eq!(
            (s.requests()[0].method.as_str(), s.requests()[0].path.as_str()),
            ("POST", "/payments")
        );
        assert_eq!(s.requests()[0].body, r#"{"coin":"USDT","network":"solana"}"#);
        assert_eq!(s.requests()[0].header("content-type"), Some("application/json"));
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(encode_component("abc-123_~.!*'()"), "abc-123_~.!*'()");
        assert_eq!(encode_component("a/b c?é"), "a%2Fb%20c%3F%C3%A9");
    }
}
