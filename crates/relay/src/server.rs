//! The gateway: runs where the public address points (the droplet). Branches connect out to it
//! over QUIC; it hands each visitor's HTTP connection and media packets to the right branch.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use quinn::crypto::rustls::QuicServerConfig;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::{TcpListener, UdpSocket};

use crate::http::{Body, forward, text};
use crate::proto::{ALPN, Hello, Welcome, decode_datagram, encode_datagram};

/// A branch allowed to connect (`branches.json`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Branch {
    pub name: String,
    /// sha256 of its secret, hex.
    pub secret_hash: String,
    /// Its public address, e.g. `home.branchr.us`.
    pub host: String,
    pub udp_base: u16,
    pub udp_ports: u16,
}

pub fn hash(secret: &str) -> String {
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn load_branches(dir: &Path) -> anyhow::Result<Vec<Branch>> {
    let f = dir.join("branches.json");
    if !f.exists() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice(&std::fs::read(f)?)?)
}

pub fn save_branches(dir: &Path, branches: &[Branch]) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join("branches.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(branches)?)?;
    std::fs::rename(tmp, dir.join("branches.json"))?;
    Ok(())
}

#[derive(Default)]
struct State {
    dir: PathBuf,
    /// Branch name -> its connection, while connected.
    live: Mutex<HashMap<String, quinn::Connection>>,
    /// Branch name -> its public media sockets (kept across reconnects).
    udp: Mutex<HashMap<String, Arc<Vec<Arc<UdpSocket>>>>>,
}

impl State {
    fn by_host(&self, host: &str) -> Option<quinn::Connection> {
        let name = load_branches(&self.dir).ok()?.into_iter().find(|b| b.host.eq_ignore_ascii_case(host))?.name;
        self.live.lock().unwrap().get(&name).cloned()
    }
}

pub async fn serve(dir: PathBuf, quic: SocketAddr, http: SocketAddr) -> anyhow::Result<()> {
    let (cert, key) = crate::tls::load_or_create(&dir)?;
    tracing::info!("relay certificate fingerprint {}", crate::tls::fingerprint(&cert));
    let mut tls = rustls::ServerConfig::builder_with_provider(crate::tls::provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)?;
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(tls)?));
    config.transport_config(crate::tls::transport());
    let endpoint = quinn::Endpoint::server(config, quic)?;
    tracing::info!("branches connect on udp {quic}; visitors on http {http}");

    let state = Arc::new(State { dir, ..Default::default() });
    tokio::spawn(serve_http(state.clone(), http));
    while let Some(incoming) = endpoint.accept().await {
        let state = state.clone();
        tokio::spawn(async move {
            match incoming.await {
                Ok(conn) => {
                    if let Err(e) = branch(state, conn).await {
                        tracing::info!("branch connection: {e:#}");
                    }
                }
                Err(e) => tracing::debug!("incoming: {e}"),
            }
        });
    }
    Ok(())
}

/// One connected branch: check who it is, then carry its media until it goes.
async fn branch(state: Arc<State>, conn: quinn::Connection) -> anyhow::Result<()> {
    let (mut send, recv) = tokio::time::timeout(std::time::Duration::from_secs(10), conn.accept_bi()).await??;
    let mut line = String::new();
    BufReader::new(recv.take(4096)).read_line(&mut line).await?;
    let hello: Hello = serde_json::from_str(&line)?;
    let known = load_branches(&state.dir)?.into_iter().find(|b| b.name == hello.name && b.secret_hash == hash(&hello.secret));
    let Some(b) = known else {
        let w = Welcome { ok: false, error: Some("unknown branch or wrong secret".into()), host: String::new(), udp_base: 0, udp_ports: 0 };
        send.write_all(format!("{}\n", serde_json::to_string(&w)?).as_bytes()).await?;
        let _ = send.finish();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        conn.close(1u32.into(), b"refused");
        anyhow::bail!("refused {}", hello.name);
    };
    let sockets = media_sockets(&state, &b).await?;
    if let Some(old) = state.live.lock().unwrap().insert(b.name.clone(), conn.clone()) {
        old.close(2u32.into(), b"replaced");
    }
    let w = Welcome { ok: true, error: None, host: b.host.clone(), udp_base: b.udp_base, udp_ports: b.udp_ports };
    send.write_all(format!("{}\n", serde_json::to_string(&w)?).as_bytes()).await?;
    tracing::info!("branch {} connected from {} as https://{}", b.name, conn.remote_address(), b.host);

    // Media from the branch back out to visitors.
    while let Ok(d) = conn.read_datagram().await {
        if let Some((i, to, payload)) = decode_datagram(&d)
            && let Some(sock) = sockets.get(i as usize)
        {
            let _ = sock.send_to(&payload, to).await;
        }
    }
    let mut live = state.live.lock().unwrap();
    if live.get(&b.name).is_some_and(|c| c.stable_id() == conn.stable_id()) {
        live.remove(&b.name);
    }
    tracing::info!("branch {} disconnected", b.name);
    Ok(())
}

/// The branch's public media ports, bound once; packets on them go to its current connection.
async fn media_sockets(state: &Arc<State>, b: &Branch) -> anyhow::Result<Arc<Vec<Arc<UdpSocket>>>> {
    if let Some(s) = state.udp.lock().unwrap().get(&b.name) {
        return Ok(s.clone());
    }
    let mut sockets = Vec::new();
    for i in 0..b.udp_ports {
        let sock = Arc::new(UdpSocket::bind(("0.0.0.0", b.udp_base + i)).await?);
        let (state, name, sock2) = (state.clone(), b.name.clone(), sock.clone());
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            while let Ok((n, from)) = sock2.recv_from(&mut buf).await {
                let conn = state.live.lock().unwrap().get(&name).cloned();
                if let Some(conn) = conn
                    && let Err(e) = conn.send_datagram(encode_datagram(i as u8, from, &buf[..n]))
                {
                    tracing::trace!("media to branch: {e}");
                }
            }
        });
        sockets.push(sock);
    }
    let sockets = Arc::new(sockets);
    state.udp.lock().unwrap().insert(b.name.clone(), sockets.clone());
    Ok(sockets)
}

async fn serve_http(state: Arc<State>, addr: SocketAddr) -> anyhow::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    loop {
        let (tcp, _) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, std::convert::Infallible>(visitor(state, req).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).with_upgrades().await;
        });
    }
}

/// One visitor request: to the branch its Host names, over a fresh stream.
async fn visitor(state: Arc<State>, req: Request<Incoming>) -> Response<Body> {
    // Caddy's on-demand TLS asks before getting a certificate for a name.
    if req.uri().path() == "/_relay/check" {
        let domain = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("domain="))).unwrap_or("");
        // `&connected` also asks that the branch be connected right now (health checks).
        let connected = req.uri().query().is_some_and(|q| q.split('&').any(|kv| kv == "connected"));
        let known = if connected { state.by_host(domain).is_some() } else { load_branches(&state.dir).is_ok_and(|bs| bs.iter().any(|b| b.host.eq_ignore_ascii_case(domain))) };
        return text(if known { StatusCode::OK } else { StatusCode::NOT_FOUND }, if known { "ok" } else { "unknown" });
    }
    let host = req.headers().get(hyper::header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").split(':').next().unwrap_or("").to_string();
    let Some(conn) = state.by_host(&host) else {
        return text(StatusCode::BAD_GATEWAY, "this branch isn't connected right now");
    };
    forward(req, |req| async move {
        let (send, recv) = conn.open_bi().await?;
        let (mut sender, c) = hyper::client::conn::http1::handshake(TokioIo::new(tokio::io::join(recv, send))).await?;
        tokio::spawn(c.with_upgrades());
        Ok(sender.send_request(req).await?)
    })
    .await
}
