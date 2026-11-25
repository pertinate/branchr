//! The gateway: runs where the public address points (the droplet). Branches connect out to it
//! over QUIC; it hands each visitor's HTTP connection and media packets to the right branch.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
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
use crate::managed::{About, Managed};
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

/// A hub admitted by pass, with the media ports set aside for its key, if any
/// (`branchr-relay add <key> - <udp-base> <ports>`).
fn pass_branch(dir: &Path, name: String) -> anyhow::Result<Branch> {
    let (udp_base, udp_ports) = load_branches(dir)?.iter().find(|b| b.name == name).map_or((0, 0), |b| (b.udp_base, b.udp_ports));
    Ok(Branch { name, secret_hash: String::new(), host: String::new(), udp_base, udp_ports })
}

/// A branch's bound media ports; dropping this frees them.
struct MediaPorts {
    base: u16,
    sockets: Arc<Vec<Arc<UdpSocket>>>,
    readers: Vec<tokio::task::AbortHandle>,
}

impl Drop for MediaPorts {
    fn drop(&mut self) {
        for r in &self.readers {
            r.abort();
        }
    }
}

/// A pass for a managed relay (its audience): this hub, its owner, and the ports it gets.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedClaims {
    sub: String,
    owner: String,
    udp_base: u16,
    udp_ports: u16,
}

#[derive(Default)]
struct State {
    dir: PathBuf,
    /// Branch name -> its connection, while connected.
    live: Mutex<HashMap<String, quinn::Connection>>,
    /// Branch name -> its public media sockets (kept across reconnects).
    udp: Mutex<HashMap<String, MediaPorts>>,
    /// Set when branchr manages us (RELAY_MANAGED=1): only the hubs linked there get in.
    managed: Option<Managed>,
    /// Carry hubs' voice and video too (RELAY_MEDIA; off where bandwidth is someone else's
    /// bill, e.g. branchr.us: hubs take media directly).
    media: bool,
    /// Show hubs their visitors' real addresses (RELAY_PASS_IP=1); otherwise each visitor gets
    /// a stand-in address per hub (stable, so rate limits work, but not traceable).
    pass_ip: bool,
    /// For the stand-in addresses (kept across restarts).
    salt: Vec<u8>,
    /// Checks hubs' passes from branchr ID (RELAY_ID_URL); none means names and secrets only.
    passes: Option<Passes>,
}

/// What a relay pass from branchr ID says.
#[derive(Deserialize)]
struct PassClaims {
    /// The hub's key.
    sub: String,
    #[serde(default)]
    claimed: bool,
}

/// Verifies relay passes against branchr ID's published keys (refetched for unknown key ids,
/// at most once a minute).
pub struct Passes {
    id_url: String,
    require_claimed: bool,
    http: reqwest::Client,
    keys: Mutex<HashMap<String, jsonwebtoken::DecodingKey>>,
    fetched: Mutex<Option<std::time::Instant>>,
}

impl Passes {
    /// The claims of a pass signed by branchr for `audience`.
    async fn claims<T: serde::de::DeserializeOwned>(&self, pass: &str, audience: &str) -> anyhow::Result<T> {
        let kid = jsonwebtoken::decode_header(pass)?.kid.ok_or_else(|| anyhow::anyhow!("pass without a key id"))?;
        if !self.keys.lock().unwrap().contains_key(&kid) {
            let due = self.fetched.lock().unwrap().is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(60));
            if due {
                *self.fetched.lock().unwrap() = Some(std::time::Instant::now());
                #[derive(Deserialize)]
                struct Jwks {
                    keys: Vec<Jwk>,
                }
                #[derive(Deserialize)]
                struct Jwk {
                    kid: String,
                    x: String,
                }
                let jwks: Jwks = self.http.get(format!("{}/.well-known/jwks.json", self.id_url)).send().await?.error_for_status()?.json().await?;
                let mut keys = self.keys.lock().unwrap();
                for k in jwks.keys {
                    keys.insert(k.kid, jsonwebtoken::DecodingKey::from_ed_components(&k.x)?);
                }
            }
        }
        let key = self.keys.lock().unwrap().get(&kid).cloned().ok_or_else(|| anyhow::anyhow!("pass signed with an unknown key"))?;
        let mut v = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::EdDSA);
        v.set_issuer(&[&self.id_url]);
        v.set_audience(&[audience]);
        Ok(jsonwebtoken::decode::<T>(pass, &key, &v)?.claims)
    }

    async fn verify(&self, pass: &str) -> anyhow::Result<String> {
        let c: PassClaims = self.claims(pass, "branchr-relay").await?;
        if self.require_claimed && !c.claimed {
            anyhow::bail!("claim this hub first (sign in and enter its claim code), then it can be reached through here");
        }
        if !c.sub.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-') || c.sub.is_empty() {
            anyhow::bail!("odd hub key in pass");
        }
        Ok(c.sub.to_ascii_lowercase())
    }
}

impl State {
    fn by_name(&self, name: &str) -> Option<quinn::Connection> {
        let live = self.live.lock().unwrap();
        live.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, c)| c.clone())
    }

    fn by_host(&self, host: &str) -> Option<(String, quinn::Connection)> {
        let name = load_branches(&self.dir).ok()?.into_iter().find(|b| !b.host.is_empty() && b.host.eq_ignore_ascii_case(host))?.name;
        let conn = self.live.lock().unwrap().get(&name).cloned()?;
        Some((name, conn))
    }

    /// The address a hub sees for a visitor: theirs (RELAY_PASS_IP), or a stand-in made from it.
    fn shown_ip(&self, hub: &str, ip: IpAddr) -> IpAddr {
        if self.pass_ip {
            return ip;
        }
        let d = Sha256::new().chain_update(&self.salt).chain_update(hub.to_ascii_lowercase()).chain_update(ip.to_string()).finalize();
        // A unique-local IPv6 address (fd00::/8): never anyone's real one.
        let mut b = [0u8; 16];
        b[0] = 0xfd;
        b[1..].copy_from_slice(&d[..15]);
        IpAddr::V6(b.into())
    }
}

pub async fn serve(dir: PathBuf, quic: SocketAddr, http: SocketAddr) -> anyhow::Result<()> {
    let (cert, key) = crate::tls::load_or_create(&dir)?;
    let cert_der = cert.to_vec();
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

    let flag = |k: &str, default: bool| std::env::var(k).ok().map_or(default, |v| !matches!(v.trim(), "0" | "off" | "false" | ""));
    let salt_file = dir.join("ip-salt");
    if !salt_file.exists() {
        let mut salt = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut salt);
        std::fs::write(&salt_file, salt)?;
    }
    let id_url = std::env::var("RELAY_ID_URL").ok().filter(|u| !u.is_empty());
    let managed = if flag("RELAY_MANAGED", false) {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let need = |k: &str| var(k).ok_or_else(|| anyhow::anyhow!("a managed relay needs {k}"));
        let about = About {
            quic: need("RELAY_PUBLIC")?,
            fp: crate::tls::fingerprint(&cert_der),
            web: need("RELAY_WEB")?.trim_end_matches('/').to_string(),
            public_ip: var("RELAY_PUBLIC_IP"),
            udp_start: need("RELAY_UDP_START")?.parse()?,
            udp_end: need("RELAY_UDP_END")?.parse()?,
        };
        anyhow::ensure!(about.udp_start <= about.udp_end, "RELAY_UDP_START is above RELAY_UDP_END");
        let url = id_url.clone().unwrap_or_else(|| "https://branchr.us".into());
        Some(Managed::new(&url, var("RELAY_NAME").unwrap_or_else(|| "My relay".into()), about, dir.clone()))
    } else {
        None
    };
    // A managed relay checks passes from the branchr that manages it.
    let passes_url = managed.as_ref().map(|m| m.id_url().to_string()).or(id_url);
    let state = Arc::new(State {
        // Carrying media is the point of a managed relay.
        media: managed.is_some() || flag("RELAY_MEDIA", true),
        pass_ip: flag("RELAY_PASS_IP", false),
        salt: std::fs::read(&salt_file)?,
        passes: passes_url.map(|u| Passes {
            id_url: u.trim_end_matches('/').to_string(),
            require_claimed: flag("RELAY_REQUIRE_CLAIMED", true),
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().expect("http client"),
            keys: Default::default(),
            fetched: Default::default(),
        }),
        dir,
        managed,
        ..Default::default()
    });
    if state.managed.is_some() {
        let state = state.clone();
        let every = std::env::var("RELAY_HEARTBEAT_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
        tokio::spawn(async move {
            loop {
                if let Some(m) = &state.managed {
                    match m.beat(std::time::Duration::ZERO).await {
                        Ok(()) => drop_unlinked(&state),
                        // Out of reach: carry on with what we were last told.
                        Err(e) => tracing::warn!("branchr: {e:#}"),
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(every.max(1))).await;
            }
        });
    }
    tracing::info!("relaying hubs' media: {}; visitors' addresses: {}", if state.media { "yes" } else { "no (direct)" }, if state.pass_ip { "passed on" } else { "stand-ins" });
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
    // A pass from branchr ID admits a hub by its key; otherwise it must be on our list.
    let admitted = if state.managed.is_some() {
        match &hello.pass {
            Some(pass) => admit_managed(&state, pass).await,
            None => Err(anyhow::anyhow!("this relay only takes hubs linked to it on branchr")),
        }
    } else {
        match &hello.pass {
        Some(pass) => match state.passes.as_ref() {
            Some(p) => p.verify(pass).await.and_then(|name| pass_branch(&state.dir, name)),
            None => Err(anyhow::anyhow!("this gateway doesn't take branchr passes")),
        },
        None => load_branches(&state.dir)?
            .into_iter()
            .find(|b| b.name == hello.name && b.secret_hash == hash(&hello.secret))
            .ok_or_else(|| anyhow::anyhow!("unknown hub or wrong secret")),
        }
    };
    let b = match admitted {
        Ok(b) => b,
        Err(e) => {
        let w = Welcome { ok: false, error: Some(format!("{e:#}")), host: String::new(), udp_base: 0, udp_ports: 0, name: String::new() };
        send.write_all(format!("{}\n", serde_json::to_string(&w)?).as_bytes()).await?;
        let _ = send.finish();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        conn.close(1u32.into(), b"refused");
        anyhow::bail!("refused {}: {e:#}", if hello.name.is_empty() { "a pass" } else { &hello.name });
        }
    };
    // Without ports set aside here, a hub's media goes direct.
    let sockets = if state.media && b.udp_ports > 0 { media_sockets(&state, &b).await? } else { Arc::new(Vec::new()) };
    if let Some(old) = state.live.lock().unwrap().insert(b.name.clone(), conn.clone()) {
        old.close(2u32.into(), b"replaced");
    }
    let w = Welcome { ok: true, error: None, host: b.host.clone(), udp_base: b.udp_base, udp_ports: if state.media { b.udp_ports } else { 0 }, name: b.name.clone() };
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

/// A hub shows a managed relay a pass naming it. The hub must also be linked here now.
async fn admit_managed(state: &State, pass: &str) -> anyhow::Result<Branch> {
    let (managed, passes) = (state.managed.as_ref().expect("managed"), state.passes.as_ref().expect("passes"));
    let me = managed.relay_id().ok_or_else(|| anyhow::anyhow!("this relay isn't registered with branchr yet"))?;
    let c: ManagedClaims = passes.claims(pass, &me).await?;
    let listed = |a: crate::managed::Allowed| a.owner.as_deref() == Some(c.owner.as_str()) && a.hubs.get(&c.sub) == Some(&(c.udp_base, c.udp_ports));
    if !listed(managed.allowed()) {
        // Just linked, perhaps: ask again.
        managed.beat(std::time::Duration::ZERO).await?;
        anyhow::ensure!(listed(managed.allowed()), "this hub isn't linked to this relay");
    }
    if !c.sub.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-') || c.sub.is_empty() {
        anyhow::bail!("odd hub key in pass");
    }
    Ok(Branch { name: c.sub, secret_hash: String::new(), host: String::new(), udp_base: c.udp_base, udp_ports: c.udp_ports })
}

/// Cuts off hubs branchr no longer links here, or whose ports moved.
fn drop_unlinked(state: &State) {
    let Some(m) = &state.managed else { return };
    let allowed = m.allowed();
    state.udp.lock().unwrap().retain(|name, ports| allowed.hubs.get(name) == Some(&(ports.base, ports.sockets.len() as u16)));
    state.live.lock().unwrap().retain(|name, conn| {
        let keep = allowed.hubs.contains_key(name);
        if !keep {
            tracing::info!("hub {name} is no longer linked here");
            conn.close(3u32.into(), b"unlinked");
        }
        keep
    });
}

/// The branch's public media ports, bound once; packets on them go to its current connection.
async fn media_sockets(state: &Arc<State>, b: &Branch) -> anyhow::Result<Arc<Vec<Arc<UdpSocket>>>> {
    {
        let mut all = state.udp.lock().unwrap();
        if let Some(p) = all.get(&b.name) {
            if p.base == b.udp_base && p.sockets.len() == b.udp_ports as usize {
                return Ok(p.sockets.clone());
            }
            all.remove(&b.name);
        }
    }
    let mut sockets = Vec::new();
    let mut readers = Vec::new();
    for i in 0..b.udp_ports {
        // Ports just freed take a moment to close.
        let mut tries = 0;
        let sock = loop {
            match UdpSocket::bind(("0.0.0.0", b.udp_base + i)).await {
                Ok(s) => break Arc::new(s),
                Err(_) if tries < 20 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e.into()),
            }
        };
        let (state, name, sock2) = (state.clone(), b.name.clone(), sock.clone());
        let reader = tokio::spawn(async move {
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
        readers.push(reader.abort_handle());
        sockets.push(sock);
    }
    let sockets = Arc::new(sockets);
    state.udp.lock().unwrap().insert(b.name.clone(), MediaPorts { base: b.udp_base, sockets: sockets.clone(), readers });
    Ok(sockets)
}

async fn serve_http(state: Arc<State>, addr: SocketAddr) -> anyhow::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    loop {
        let (tcp, peer) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, std::convert::Infallible>(visitor(state, peer, req).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(tcp), svc).with_upgrades().await;
        });
    }
}

/// One visitor request: to the branch its Host names, over a fresh stream.
async fn visitor(state: Arc<State>, peer: SocketAddr, req: Request<Incoming>) -> Response<Body> {
    // Caddy's on-demand TLS asks before getting a certificate for a name.
    if req.uri().path() == "/_relay/check" {
        let domain = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("domain="))).unwrap_or("");
        // `&connected` also asks that the branch be connected right now (health checks).
        let connected = req.uri().query().is_some_and(|q| q.split('&').any(|kv| kv == "connected"));
        let known = if connected { state.by_host(domain).is_some() } else { load_branches(&state.dir).is_ok_and(|bs| bs.iter().any(|b| b.host.eq_ignore_ascii_case(domain))) };
        return text(if known { StatusCode::OK } else { StatusCode::NOT_FOUND }, if known { "ok" } else { "unknown" });
    }
    // `/h/<name>/...` reaches a hub under the gateway's own address (prefix removed);
    // otherwise the Host header names it.
    let mut req = req;
    let routed = match path_hub(req.uri()) {
        Some((name, rest)) => {
            let Some(conn) = state.by_name(&name).map(|c| (name.clone(), c)) else {
                return text(StatusCode::BAD_GATEWAY, "this hub isn't connected right now");
            };
            if rest.is_empty() {
                // `/h/name` → `/h/name/`, so relative links resolve under it.
                let mut r = text(StatusCode::PERMANENT_REDIRECT, "");
                r.headers_mut().insert(hyper::header::LOCATION, format!("/h/{name}/").parse().expect("location"));
                return r;
            }
            match rest.parse() {
                Ok(uri) => *req.uri_mut() = uri,
                Err(_) => return text(StatusCode::BAD_REQUEST, "bad path"),
            }
            if let Ok(v) = format!("/h/{name}").parse() {
                req.headers_mut().insert("x-forwarded-prefix", v);
            }
            conn
        }
        None => {
            let host = req.headers().get(hyper::header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("").split(':').next().unwrap_or("").to_string();
            match state.by_host(&host) {
                Some(found) => found,
                None => return text(StatusCode::BAD_GATEWAY, "this hub isn't connected right now"),
            }
        }
    };
    let (hub, conn) = routed;
    // The visitor, as the proxy in front of us (Caddy) saw them, then as the hub may see them.
    let client = req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit(',').next()).and_then(|v| v.trim().parse().ok()).unwrap_or(peer.ip());
    let shown = state.shown_ip(&hub, client);
    req.headers_mut().remove("x-real-ip");
    if let Ok(v) = shown.to_string().parse() {
        req.headers_mut().insert("x-forwarded-for", v);
    }
    forward(req, |req| async move {
        let (send, recv) = conn.open_bi().await?;
        let (mut sender, c) = hyper::client::conn::http1::handshake(TokioIo::new(tokio::io::join(recv, send))).await?;
        tokio::spawn(c.with_upgrades());
        Ok(sender.send_request(req).await?)
    })
    .await
}

/// `/h/<name><rest>` → (name, rest with its query); `rest` is empty for a bare `/h/<name>`.
fn path_hub(uri: &hyper::Uri) -> Option<(String, String)> {
    let path = uri.path().strip_prefix("/h/")?;
    let (name, rest) = path.split_once('/').map_or((path, ""), |(n, r)| (n, r));
    if name.is_empty() {
        return None;
    }
    if rest.is_empty() && !uri.path().ends_with('/') {
        return Some((name.to_string(), String::new()));
    }
    let q = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    Some((name.to_string(), format!("/{rest}{q}")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn visitors_get_stand_in_addresses() {
        let state = super::State { salt: b"salt".to_vec(), ..Default::default() };
        let ip: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        let a = state.shown_ip("home", ip);
        assert_eq!(a, state.shown_ip("HOME", ip), "stable per hub");
        assert_ne!(a, state.shown_ip("other", ip), "not the same across hubs");
        assert_ne!(a, state.shown_ip("home", "203.0.113.10".parse().unwrap()));
        assert!(matches!(a, std::net::IpAddr::V6(v6) if v6.segments()[0] >> 8 == 0xfd));
        let passing = super::State { pass_ip: true, ..Default::default() };
        assert_eq!(passing.shown_ip("home", ip), ip);
    }

    #[test]
    fn hubs_by_path() {
        let p = |u: &str| super::path_hub(&u.parse().unwrap());
        assert_eq!(p("/h/home/api/health"), Some(("home".into(), "/api/health".into())));
        assert_eq!(p("/h/home/"), Some(("home".into(), "/".into())));
        assert_eq!(p("/h/home"), Some(("home".into(), "".into())));
        assert_eq!(p("/h/home/gateway?v=1"), Some(("home".into(), "/gateway?v=1".into())));
        assert_eq!(p("/api/health"), None);
        assert_eq!(p("/h/"), None);
    }
}

#[cfg(test)]
mod pass_tests {
    use super::*;

    #[test]
    fn pass_hubs_get_the_ports_set_aside_for_their_key() {
        let dir = std::env::temp_dir().join(format!("branchr-relay-pass-{}", std::process::id()));
        let key = "01a13356-c1d7-7715-882a-9ee2317be535";
        let ports = |name: &str| {
            let b = pass_branch(&dir, name.into()).unwrap();
            (b.udp_base, b.udp_ports)
        };
        assert_eq!(ports(key), (0, 0));
        save_branches(&dir, &[Branch { name: key.into(), secret_hash: hash("s"), host: String::new(), udp_base: 53000, udp_ports: 4 }]).unwrap();
        assert_eq!(ports(key), (53000, 4));
        assert_eq!(ports("another"), (0, 0));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
