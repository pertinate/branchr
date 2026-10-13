//! Finding our public address for SFU_PUBLIC_IP=auto (a hub at home): ask the router over
//! UPnP, which also forwards our UDP ports to us, or else ask branchr what IP we come from.
//! Rechecked every so often, since home connections change IP.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use igd_next::{PortMappingProtocol, SearchOptions};
use serde::Serialize;

use crate::config::Config;
use crate::shared::Shared;

/// UPnP leases run this long; we renew at half.
const LEASE_SECS: u32 = 3600;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub public_ip: Option<String>,
    pub lan_ip: Option<String>,
    pub ports: Vec<u16>,
    /// How the public address was found: "fixed", "upnp" or "echo".
    pub via: String,
    /// The router forwarded our ports (UPnP).
    pub forwarded: bool,
    /// Something to tell the owner, e.g. a shared (CGNAT) address.
    pub warning: Option<String>,
}

pub type SharedStatus = Arc<parking_lot::RwLock<Status>>;

pub fn initial(config: &Config) -> SharedStatus {
    // The ports clients send to (forwarded to ours one for one with UPnP).
    let ports = (0..config.workers).map(|i| config.public_udp_port + i as u16).collect();
    Arc::new(parking_lot::RwLock::new(Status {
        public_ip: Some(config.public_ip.to_string()),
        lan_ip: config.lan_ip.map(|ip| ip.to_string()),
        ports,
        via: if config.public_auto { "pending".into() } else { "fixed".into() },
        ..Default::default()
    }))
}

pub async fn keep_current(config: Config, shared: Arc<Shared>, status: SharedStatus) {
    let ports: Vec<u16> = (0..config.workers).map(|i| config.udp_port + i as u16).collect();
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client");
    loop {
        let found = match (config.upnp, config.lan_ip) {
            (true, Some(lan)) => match upnp(lan, &ports).await {
                Ok(ip) => Some((ip, "upnp", true)),
                Err(e) => {
                    tracing::info!("UPnP: {e:#}; asking {} instead", config.ip_echo);
                    None
                }
            },
            _ => None,
        };
        let found = match found {
            Some(f) => Some(f),
            None => echo(&http, &config.ip_echo).await.map(|ip| (ip, "echo", false)).inspect_err(|e| tracing::warn!("finding our public IP: {e:#}")).ok(),
        };
        if let Some((ip, via, forwarded)) = found {
            let changed = *shared.public_ip.read() != ip;
            *shared.public_ip.write() = ip;
            let warning = shared_address(ip).then(|| {
                format!("{ip} is a shared address (CGNAT): people outside your network can't reach this hub's voice directly")
            });
            if changed {
                tracing::info!("public address {ip} (via {via}{})", if forwarded { ", ports forwarded" } else { "" });
            }
            if let Some(w) = &warning {
                tracing::warn!("{w}");
            }
            let mut s = status.write();
            s.public_ip = Some(ip.to_string());
            s.via = via.into();
            s.forwarded = forwarded;
            s.warning = warning;
        }
        tokio::time::sleep(Duration::from_secs(u64::from(LEASE_SECS) / 2)).await;
    }
}

/// Forwards each port to us on the router and asks it for our public IP.
async fn upnp(lan: IpAddr, ports: &[u16]) -> anyhow::Result<IpAddr> {
    let gw = igd_next::aio::tokio::search_gateway(SearchOptions { timeout: Some(Duration::from_secs(3)), ..Default::default() }).await?;
    let ip = gw.get_external_ip().await?;
    for &port in ports {
        gw.add_port(PortMappingProtocol::UDP, port, SocketAddr::new(lan, port), LEASE_SECS, "branchr voice").await?;
    }
    Ok(ip)
}

async fn echo(http: &reqwest::Client, url: &str) -> anyhow::Result<IpAddr> {
    Ok(http.get(url).send().await?.error_for_status()?.text().await?.trim().parse()?)
}

/// A private, CGNAT (100.64/10) or otherwise unroutable address: not reachable from outside.
fn shared_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1])),
        IpAddr::V6(_) => false,
    }
}
