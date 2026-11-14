//! A tiny local HTTP server for the tests of the API client and the wallet RPCs.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// One request the stub received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// What the stub answers.
pub enum Reply {
    /// Status, extra headers, body.
    Full(u16, Vec<(&'static str, String)>, String),
    /// These bytes as they are, then the connection is dropped.
    Raw(String),
}

pub fn json(status: u16, body: &str) -> Reply {
    Reply::Full(status, vec![("content-type", "application/json".into())], body.into())
}

pub struct Stub {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Seen>>>,
    task: JoinHandle<()>,
}

impl Stub {
    pub fn requests(&self) -> Vec<Seen> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts a server on a free port. `reply` gets each request and how many came so far (this one included).
pub async fn stub(reply: impl Fn(&Seen, usize) -> Reply + Send + Sync + 'static) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let reply = Arc::new(reply);
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let (seen, reply) = (seen.clone(), reply.clone());
            tokio::spawn(async move {
                let _ = serve(socket, seen, reply.as_ref()).await;
            });
        }
    });
    Stub { url, requests, task }
}

async fn serve(
    mut socket: TcpStream,
    seen: Arc<Mutex<Vec<Seen>>>,
    reply: &(dyn Fn(&Seen, usize) -> Reply + Send + Sync),
) -> std::io::Result<()> {
    loop {
        let Some(request) = read_request(&mut socket).await? else {
            return Ok(());
        };
        let count = {
            let mut all = seen.lock().unwrap();
            all.push(request.clone());
            all.len()
        };
        match reply(&request, count) {
            Reply::Raw(bytes) => {
                socket.write_all(bytes.as_bytes()).await?;
                return Ok(());
            }
            Reply::Full(status, headers, body) => {
                let mut head = format!("HTTP/1.1 {status} Stub\r\ncontent-length: {}\r\n", body.len());
                for (name, value) in headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                socket.write_all(head.as_bytes()).await?;
                socket.write_all(body.as_bytes()).await?;
            }
        }
    }
}

async fn read_request(socket: &mut TcpStream) -> std::io::Result<Option<Seen>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let method = first.next().unwrap_or_default().to_string();
    let path = first.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < length {
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(Some(Seen {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    }))
}
