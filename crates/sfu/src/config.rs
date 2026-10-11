use std::net::{IpAddr, SocketAddr, UdpSocket};

#[derive(Debug, Clone)]
pub struct Config {
    /// HTTP/WebSocket signaling bind address.
    pub bind: SocketAddr,
    /// First UDP port; worker `i` listens on `udp_port + i`.
    pub udp_port: u16,
    pub workers: usize,
    /// IP advertised in ICE candidates (the address clients send media to).
    pub public_ip: IpAddr,
    pub voice_secret: Vec<u8>,
    /// Initial per-subscriber bandwidth estimate in bits/s before TWCC converges.
    pub initial_bwe_bps: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let public_ip = match var("SFU_PUBLIC_IP") {
            Some(ip) => ip.parse()?,
            None => {
                let ip = detect_local_ip().unwrap_or(IpAddr::from([127, 0, 0, 1]));
                tracing::warn!("SFU_PUBLIC_IP not set, advertising {ip}");
                ip
            }
        };
        Ok(Self {
            bind: var("SFU_BIND").unwrap_or_else(|| "0.0.0.0:8090".into()).parse()?,
            udp_port: var("SFU_UDP_PORT").map(|p| p.parse()).transpose()?.unwrap_or(50000),
            workers: var("SFU_WORKERS")
                .map(|w| w.parse())
                .transpose()?
                .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2)),
            public_ip,
            voice_secret: var("VOICE_SECRET").unwrap_or_else(|| "dev-voice-secret".into()).into_bytes(),
            initial_bwe_bps: var("SFU_INITIAL_BWE").map(|p| p.parse()).transpose()?.unwrap_or(5_000_000),
        })
    }
}

/// The address the OS would route public traffic from (no packet is sent).
fn detect_local_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("1.1.1.1:80").ok()?;
    Some(s.local_addr().ok()?.ip())
}
