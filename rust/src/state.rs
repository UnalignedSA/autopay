//! The state file: every top-up, so that a restart never pays twice. Written atomically.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Created,
    Sending,
    Sent,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TopupKind {
    Invoice,
    Deposit,
}

impl std::fmt::Display for TopupKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TopupKind::Invoice => "invoice",
            TopupKind::Deposit => "deposit",
        })
    }
}

/// One top-up. The file is meant to be hand-edited after a manual check, so every field is checked on
/// load: a field that may be null must still be present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topup {
    /// Invoice id, or "deposit:<txid>" for a deposit ("deposit:pending" until the txid is known).
    pub id: String,
    pub kind: TopupKind,
    pub network: String,
    pub coin: String,
    pub amount_usd: f64,
    pub amount_crypto: String,
    pub address: String,
    /// Milliseconds since 1970. Null for a deposit address, which never expires.
    #[serde(deserialize_with = "nullable")]
    pub expires_at: Option<i64>,
    pub phase: Phase,
    #[serde(deserialize_with = "nullable")]
    pub txid: Option<String>,
    pub created_at: i64,
    #[serde(deserialize_with = "nullable")]
    pub sent_at: Option<i64>,
    /// Final status: paid, expired, refunded or credited.
    #[serde(deserialize_with = "nullable")]
    pub result: Option<String>,
}

/// A value or null, but present: serde would otherwise read a missing field as null.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub topups: Vec<Topup>,
}

impl Default for State {
    fn default() -> Self {
        State {
            version: 1,
            topups: Vec::new(),
        }
    }
}

#[derive(Debug, Error)]
#[error("{0}")]
pub struct StateError(pub String);

pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        StateStore { path: path.into() }
    }

    /// A missing file is an empty state. Anything else that is not a valid state is an error.
    pub fn load(&self) -> Result<State, StateError> {
        let path = self.path.display();
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(State::default()),
            Err(err) => return Err(StateError(format!("cannot read state file {path}: {err}"))),
        };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| StateError(format!("state file {path} is not valid JSON; fix or remove it by hand")))?;
        serde_json::from_value::<State>(value)
            .ok()
            .filter(|state| state.version == 1)
            .ok_or_else(|| {
                StateError(format!(
                    "state file {path} has an unknown format; fix or remove it by hand"
                ))
            })
    }

    /// Writes to a temporary file, fsyncs it, then renames it over the real one.
    pub fn save(&self, state: &State) -> Result<(), StateError> {
        self.write(state)
            .map_err(|err| StateError(format!("cannot write state file {}: {err}", self.path.display())))
    }

    fn write(&self, state: &State) -> io::Result<()> {
        let dir = match self.path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir,
            _ => Path::new("."),
        };
        fs::create_dir_all(dir)?;
        let mut tmp_name = self.path.as_os_str().to_owned();
        tmp_name.push(".tmp");
        let tmp = PathBuf::from(tmp_name);

        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp)?;
        let mut text = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
        text.push('\n');
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &self.path)?;
        // Make the rename itself durable. Not possible on every platform (Windows): best effort.
        if let Ok(dir) = fs::File::open(dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("autopay-test-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn record() -> serde_json::Value {
        serde_json::json!({
            "id": "inv-1", "kind": "invoice", "network": "bsc", "coin": "USDT", "amountUsd": 50,
            "amountCrypto": "50.00", "address": "0xinvoice", "expiresAt": 1793926800000_i64, "phase": "created",
            "txid": null, "createdAt": 1793925000000_i64, "sentAt": null, "result": null
        })
    }

    #[test]
    fn a_missing_file_is_an_empty_state() {
        let dir = TempDir::new();
        let state = StateStore::new(dir.0.join("state.json")).load().unwrap();
        assert_eq!(state, State::default());
    }

    #[test]
    fn saves_and_loads_the_documented_format() {
        let dir = TempDir::new();
        let path = dir.0.join("sub").join("state.json");
        let store = StateStore::new(&path);
        let topup: Topup = serde_json::from_value(record()).unwrap();
        store
            .save(&State {
                version: 1,
                topups: vec![topup.clone()],
            })
            .unwrap();
        assert_eq!(store.load().unwrap().topups, vec![topup]);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("{\n  \"version\": 1,\n  \"topups\": [\n"), "{text}");
        assert!(text.contains("\"amountCrypto\": \"50.00\""));
        assert!(text.contains("\"sentAt\": null"));
        assert!(text.ends_with("}\n"));
        assert!(!dir.0.join("sub").join("state.json.tmp").exists());
    }

    #[test]
    fn invalid_json_is_an_error() {
        let dir = TempDir::new();
        let path = dir.0.join("state.json");
        std::fs::write(&path, "{not json").unwrap();
        let err = StateStore::new(&path).load().unwrap_err();
        assert!(err.0.contains("not valid JSON"), "{}", err.0);
    }

    #[test]
    fn a_malformed_record_or_version_is_an_error() {
        let dir = TempDir::new();
        let path = dir.0.join("state.json");
        let store = StateStore::new(&path);
        let mut bad = Vec::new();
        for (field, value) in [
            ("phase", serde_json::json!("sendng")),
            ("network", serde_json::json!(7)),
            ("txid", serde_json::json!(5)),
            ("sentAt", serde_json::json!("1793925000000")),
            ("expiresAt", serde_json::json!("soon")),
            ("amountUsd", serde_json::json!("50")),
        ] {
            let mut r = record();
            r[field] = value;
            bad.push(serde_json::json!({ "version": 1, "topups": [r] }));
        }
        for missing in ["coin", "txid", "sentAt", "result", "expiresAt"] {
            let mut r = record();
            r.as_object_mut().unwrap().remove(missing);
            bad.push(serde_json::json!({ "version": 1, "topups": [r] }));
        }
        bad.push(serde_json::json!({ "version": 2, "topups": [] }));
        bad.push(serde_json::json!({ "topups": [] }));
        bad.push(serde_json::json!([]));
        for state in bad {
            std::fs::write(&path, state.to_string()).unwrap();
            let err = store.load().expect_err(&state.to_string());
            assert!(err.0.contains("unknown format"), "{}", err.0);
        }
    }
}
