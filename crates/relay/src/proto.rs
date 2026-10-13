//! What gateway and connector say to each other.
//!
//! One QUIC connection per branch, opened by the connector. Its first bidirectional stream is
//! the control stream (one JSON line each way: `Hello`, then `Welcome`). Every later stream the
//! gateway opens carries one HTTP/1.1 connection from a visitor. Media rides QUIC datagrams:
//! `[port index][client address][UDP payload]`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use bytes::{BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"branchr-relay/1";
/// The name in the gateway's (self-signed) certificate; trust comes from its fingerprint.
pub const SERVER_NAME: &str = "branchr-relay";

/// The connector's introduction: a name and secret the gateway was given (`branchr-relay
/// add`), or a pass from branchr ID naming the hub by its key.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct Hello {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub secret: String,
    #[serde(default)]
    pub pass: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Welcome {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// The public address visitors use.
    #[serde(default)]
    pub host: String,
    /// Public UDP ports for media: `udp_base .. udp_base + udp_ports`.
    #[serde(default)]
    pub udp_base: u16,
    #[serde(default)]
    pub udp_ports: u16,
    /// The hub's name here: it's at `https://<gateway>/h/<name>/`.
    #[serde(default)]
    pub name: String,
}

/// Everything a connector needs, as one string (`branchr-relay add` prints it).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Token {
    /// Gateway's QUIC address, `host:port`.
    pub relay: String,
    pub name: String,
    pub secret: String,
    /// sha256 of the gateway's certificate, hex.
    pub fp: String,
}

impl Token {
    pub fn encode(&self) -> String {
        format!("brt1.{}", B64.encode(serde_json::to_vec(self).expect("token json")))
    }

    pub fn decode(s: &str) -> anyhow::Result<Self> {
        let body = s.trim().strip_prefix("brt1.").ok_or_else(|| anyhow::anyhow!("not a branchr relay token"))?;
        Ok(serde_json::from_slice(&B64.decode(body)?)?)
    }
}

/// `[port index][family][address][port][payload]`.
pub fn encode_datagram(index: u8, addr: SocketAddr, payload: &[u8]) -> Bytes {
    let mut b = BytesMut::with_capacity(payload.len() + 20);
    b.put_u8(index);
    match addr.ip() {
        IpAddr::V4(ip) => {
            b.put_u8(4);
            b.put_slice(&ip.octets());
        }
        IpAddr::V6(ip) => {
            b.put_u8(6);
            b.put_slice(&ip.octets());
        }
    }
    b.put_u16(addr.port());
    b.put_slice(payload);
    b.freeze()
}

pub fn decode_datagram(d: &Bytes) -> Option<(u8, SocketAddr, Bytes)> {
    let index = *d.first()?;
    let (ip, rest): (IpAddr, usize) = match *d.get(1)? {
        4 => (IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(d.get(2..6)?).ok()?)), 6),
        6 => (IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(d.get(2..18)?).ok()?)), 18),
        _ => return None,
    };
    let port = u16::from_be_bytes(d.get(rest..rest + 2)?.try_into().ok()?);
    Some((index, SocketAddr::new(ip, port), d.slice(rest + 2..)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datagrams_round_trip() {
        for addr in ["203.0.113.9:51000", "[2001:db8::1]:443"] {
            let addr: SocketAddr = addr.parse().unwrap();
            let d = encode_datagram(3, addr, b"rtp");
            assert_eq!(decode_datagram(&d), Some((3, addr, Bytes::from_static(b"rtp"))));
        }
        assert_eq!(decode_datagram(&Bytes::from_static(&[0, 9])), None);
    }

    #[test]
    fn tokens_round_trip() {
        let t = Token { relay: "branchr.us:7443".into(), name: "home".into(), secret: "s".into(), fp: "ab".into() };
        assert_eq!(Token::decode(&t.encode()).unwrap(), t);
        assert!(Token::decode("nope").is_err());
    }
}
