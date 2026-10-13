//! Helping hubs at home find out how the internet sees them: `GET /ip` says what address a
//! request came from (when the router won't say), and `POST /probe` checks whether that
//! address answers on given UDP ports (whether direct voice will work). Probes only ever go
//! back to the address that asked, one small packet per port.

use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::Json;
use axum::Extension;
use axum::extract::ConnectInfo;
use axum::http::HeaderMap;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result, bad};

/// Matches the SFU's echo (crates/sfu: `PROBE`).
const PROBE: &[u8] = b"BRANCHR-PROBE";
const MAX_PORTS: usize = 16;

fn caller(peer: Option<SocketAddr>, headers: &HeaderMap) -> Result<IpAddr> {
    throttle::client_ip(peer, headers, throttle::trust_proxy_from_env()).ok_or_else(|| Error::Internal(anyhow::anyhow!("no client address")))
}

pub async fn ip(peer: Option<Extension<ConnectInfo<SocketAddr>>>, headers: HeaderMap) -> Result<String> {
    Ok(caller(peer.map(|c| c.0.0), &headers)?.to_string())
}

#[derive(Deserialize)]
pub struct ProbeRequest {
    ports: Vec<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// The address that was probed (the caller's).
    pub ip: String,
    /// The ports that answered.
    pub reachable: Vec<u16>,
}

pub async fn probe(peer: Option<Extension<ConnectInfo<SocketAddr>>>, headers: HeaderMap, Json(body): Json<ProbeRequest>) -> Result<Json<ProbeResult>> {
    let ip = caller(peer.map(|c| c.0.0), &headers)?;
    let ports: Vec<u16> = body.ports.into_iter().filter(|p| *p >= 1024).collect::<HashSet<_>>().into_iter().collect();
    if ports.is_empty() || ports.len() > MAX_PORTS {
        return Err(bad("invalid_request", format!("probe 1-{MAX_PORTS} ports (1024 and up)")));
    }
    let sock = tokio::net::UdpSocket::bind(if ip.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).await.map_err(|e| Error::Internal(e.into()))?;
    let mut nonce = [0u8; 8];
    rand::rng().fill_bytes(&mut nonce);
    let packet = [PROBE, b":", &nonce].concat();
    for &port in &ports {
        let _ = sock.send_to(&packet, SocketAddr::new(ip, port)).await;
    }
    let mut reachable = HashSet::new();
    let mut buf = [0u8; 64];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while reachable.len() < ports.len() {
        match tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, from))) if buf[..n] == packet[..] && from.ip() == ip => {
                reachable.insert(from.port());
            }
            Ok(Ok(_)) => {}
            _ => break,
        }
    }
    let mut reachable: Vec<u16> = reachable.into_iter().collect();
    reachable.sort_unstable();
    Ok(Json(ProbeResult { ip: ip.to_string(), reachable }))
}
