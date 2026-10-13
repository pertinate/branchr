//! The connector: runs next to a branch (at home), dials out to the gateway, and serves what
//! comes back: HTTP to the branch's api and sfu, media to the sfu's UDP ports.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};
use quinn::crypto::rustls::QuicClientConfig;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::UdpSocket;

use crate::http::{Body, forward};
use crate::proto::{ALPN, Hello, SERVER_NAME, Token, Welcome, decode_datagram, encode_datagram};

#[derive(Clone)]
pub struct Targets {
    /// The branch's api, e.g. `http://127.0.0.1:8080`.
    pub api: String,
    /// Its sfu's signaling; `/sfu/...` goes here (without the prefix), like the Caddy setup.
    pub sfu: String,
    /// Its sfu's first UDP port; public port `i` goes to `sfu_udp + i`.
    pub sfu_udp: SocketAddr,
}

pub async fn run(token: Token, targets: Targets) -> anyhow::Result<()> {
    let mut tls = rustls::ClientConfig::builder_with_provider(crate::tls::provider())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(crate::tls::Pinned::new(&token.fp))
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut config = quinn::ClientConfig::new(Arc::new(QuicClientConfig::try_from(tls)?));
    config.transport_config(crate::tls::transport());
    let mut endpoint = quinn::Endpoint::client("[::]:0".parse()?).or_else(|_| quinn::Endpoint::client("0.0.0.0:0".parse().expect("addr")))?;
    endpoint.set_default_client_config(config);
    let client: Client<HttpConnector, Incoming> = Client::builder(TokioExecutor::new()).build_http();

    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        match session(&endpoint, &token, &targets, &client).await {
            Ok(()) => tracing::warn!("relay connection closed"),
            Err(e) => tracing::warn!("relay: {e:#}"),
        }
        // A connection that lasted a while starts the waiting over.
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn session(endpoint: &quinn::Endpoint, token: &Token, targets: &Targets, client: &Client<HttpConnector, Incoming>) -> anyhow::Result<()> {
    let addr = tokio::net::lookup_host(&token.relay).await?.next().ok_or_else(|| anyhow::anyhow!("can't resolve {}", token.relay))?;
    let conn = endpoint.connect(addr, SERVER_NAME)?.await?;
    let (mut send, recv) = conn.open_bi().await?;
    send.write_all(format!("{}\n", serde_json::to_string(&Hello { name: token.name.clone(), secret: token.secret.clone() })?).as_bytes()).await?;
    let mut line = String::new();
    BufReader::new(recv.take(4096)).read_line(&mut line).await?;
    let w: Welcome = serde_json::from_str(&line)?;
    if !w.ok {
        anyhow::bail!("refused: {}", w.error.unwrap_or_default());
    }
    tracing::info!("relaying https://{} (media on {} UDP port(s) from {})", w.host, w.udp_ports, w.udp_base);

    let media = Media::new(conn.clone(), targets.sfu_udp);
    let datagrams = {
        let (conn, media) = (conn.clone(), media.clone());
        tokio::spawn(async move {
            while let Ok(d) = conn.read_datagram().await {
                if let Some((i, from, payload)) = decode_datagram(&d) {
                    media.to_sfu(i, from, &payload).await;
                }
            }
        })
    };
    let janitor = {
        let media = media.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                media.forget_idle(Duration::from_secs(120));
            }
        })
    };
    while let Ok((send, recv)) = conn.accept_bi().await {
        let (targets, client) = (targets.clone(), client.clone());
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let (targets, client) = (targets.clone(), client.clone());
                async move { Ok::<_, std::convert::Infallible>(to_branch(&targets, &client, req).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(tokio::io::join(recv, send)), svc).with_upgrades().await;
        });
    }
    datagrams.abort();
    janitor.abort();
    media.clear();
    Ok(())
}

/// `/sfu/...` to the sfu (prefix removed), everything else to the api.
async fn to_branch(targets: &Targets, client: &Client<HttpConnector, Incoming>, mut req: Request<Incoming>) -> Response<Body> {
    let pq = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let (base, rest) = match pq.strip_prefix("/sfu") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') => (&targets.sfu, if rest.is_empty() { "/".to_string() } else { rest.to_string() }),
        _ => (&targets.api, pq.clone()),
    };
    match format!("{}{}", base.trim_end_matches('/'), rest).parse::<Uri>() {
        Ok(uri) => *req.uri_mut() = uri,
        Err(_) => return crate::http::text(hyper::StatusCode::BAD_REQUEST, "bad path"),
    }
    let client = client.clone();
    forward(req, |req| async move { Ok(client.request(req).await?) }).await
}

/// Visitors' media: one local socket per (public port, visitor), so the sfu sees each visitor
/// as its own address and its replies find their way back.
#[derive(Clone)]
struct Media {
    conn: quinn::Connection,
    sfu: SocketAddr,
    flows: Arc<Mutex<HashMap<(u8, SocketAddr), Flow>>>,
}

struct Flow {
    sock: Arc<UdpSocket>,
    last: Instant,
    reader: tokio::task::JoinHandle<()>,
}

impl Media {
    fn new(conn: quinn::Connection, sfu: SocketAddr) -> Self {
        Self { conn, sfu, flows: Default::default() }
    }

    async fn to_sfu(&self, i: u8, visitor: SocketAddr, payload: &[u8]) {
        let existing = self.flows.lock().unwrap().get_mut(&(i, visitor)).map(|f| {
            f.last = Instant::now();
            f.sock.clone()
        });
        let sock = match existing {
            Some(s) => s,
            None => match self.open(i, visitor).await {
                Ok(s) => s,
                Err(e) => {
                    tracing::debug!("media flow: {e}");
                    return;
                }
            },
        };
        let _ = sock.send(payload).await;
    }

    async fn open(&self, i: u8, visitor: SocketAddr) -> std::io::Result<Arc<UdpSocket>> {
        let target = SocketAddr::new(self.sfu.ip(), self.sfu.port() + i as u16);
        let local = if target.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
        let sock = Arc::new(UdpSocket::bind(local).await?);
        sock.connect(target).await?;
        let (conn, s) = (self.conn.clone(), sock.clone());
        let reader = tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            while let Ok(n) = s.recv(&mut buf).await {
                if let Err(e) = conn.send_datagram(encode_datagram(i, visitor, &buf[..n])) {
                    tracing::trace!("media to gateway: {e}");
                }
            }
        });
        self.flows.lock().unwrap().insert((i, visitor), Flow { sock: sock.clone(), last: Instant::now(), reader });
        Ok(sock)
    }

    fn forget_idle(&self, after: Duration) {
        self.flows.lock().unwrap().retain(|_, f| {
            let keep = f.last.elapsed() < after;
            if !keep {
                f.reader.abort();
            }
            keep
        });
    }

    fn clear(&self) {
        for (_, f) in self.flows.lock().unwrap().drain() {
            f.reader.abort();
        }
    }
}
