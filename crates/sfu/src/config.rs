use std::net::{IpAddr, SocketAddr, UdpSocket};

#[derive(Debug, Clone)]
pub struct Config {
    /// HTTP/WebSocket signaling bind address.
    pub bind: SocketAddr,
    /// First UDP port; worker `i` listens on `udp_port + i`.
    pub udp_port: u16,
    pub workers: usize,
    /// IP advertised in ICE candidates (the address clients send media to). With
    /// SFU_PUBLIC_IP=auto this is a first guess, kept current by `addrs` (UPnP, else an echo).
    pub public_ip: IpAddr,
    pub public_auto: bool,
    /// Also offered to clients (people on the same network connect locally); defaults to this
    /// machine's own address with SFU_PUBLIC_IP=auto.
    pub lan_ip: Option<IpAddr>,
    /// Asks the router to forward our UDP ports (with SFU_PUBLIC_IP=auto; SFU_UPNP=0 turns it off).
    pub upnp: bool,
    /// Says what IP we come from, when the router won't (UPnP).
    pub ip_echo: String,
    /// First UDP port advertised (worker `i` advertises `public_udp_port + i`). Differs from
    /// `udp_port` behind a relay that forwards other public ports to ours.
    pub public_udp_port: u16,
    pub voice_secret: Vec<u8>,
    /// Initial per-subscriber bandwidth estimate in bits/s before TWCC converges.
    pub initial_bwe_bps: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let public_auto = var("SFU_PUBLIC_IP").is_some_and(|v| v == "auto");
        let public_ip = match var("SFU_PUBLIC_IP").filter(|_| !public_auto) {
            Some(ip) => ip.parse()?,
            None if public_auto => detect_local_ip().unwrap_or(IpAddr::from([127, 0, 0, 1])),
            None => {
                let ip = detect_local_ip().unwrap_or(IpAddr::from([127, 0, 0, 1]));
                tracing::warn!("SFU_PUBLIC_IP not set, advertising {ip}");
                ip
            }
        };
        let udp_port = var("SFU_UDP_PORT").map(|p| p.parse()).transpose()?.unwrap_or(50000);
        Ok(Self {
            bind: var("SFU_BIND").unwrap_or_else(|| "0.0.0.0:8090".into()).parse()?,
            udp_port,
            public_udp_port: var("SFU_PUBLIC_UDP_PORT").map(|p| p.parse()).transpose()?.unwrap_or(udp_port),
            workers: var("SFU_WORKERS")
                .map(|w| w.parse())
                .transpose()?
                .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2)),
            public_ip,
            public_auto,
            lan_ip: match var("SFU_LAN_IP") {
                Some(ip) => Some(ip.parse()?),
                None if public_auto => detect_local_ip(),
                None => None,
            },
            upnp: public_auto && var("SFU_UPNP").is_none_or(|v| v != "0"),
            ip_echo: var("SFU_IP_ECHO").unwrap_or_else(|| "https://branchr.us/ip".into()),
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
