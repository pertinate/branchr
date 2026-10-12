//! Token-bucket rate limits, per key or per client address, shared by the services.

use std::hash::Hash;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use dashmap::DashMap;

/// Per-key token bucket: `capacity` at once, refilled evenly over `per_secs`.
pub struct Buckets<K> {
    capacity: f64,
    refill_per_sec: f64,
    buckets: DashMap<K, (f64, Instant)>,
}

impl<K: Eq + Hash> Buckets<K> {
    pub fn new(capacity: u32, per_secs: f64) -> Self {
        Self { capacity: capacity as f64, refill_per_sec: capacity as f64 / per_secs, buckets: DashMap::new() }
    }

    /// Takes a token for `key`; false when there's none left.
    pub fn check(&self, key: K) -> bool {
        self.wait(key).is_none()
    }

    /// Takes a token for `key`, or says how long until the next one.
    pub fn wait(&self, key: K) -> Option<Duration> {
        let now = Instant::now();
        let mut b = self.buckets.entry(key).or_insert((self.capacity, now));
        let (tokens, last) = *b;
        let tokens = (tokens + now.duration_since(last).as_secs_f64() * self.refill_per_sec).min(self.capacity);
        if tokens >= 1.0 {
            *b = (tokens - 1.0, now);
            None
        } else {
            *b = (tokens, now);
            Some(Duration::from_secs_f64((1.0 - tokens) / self.refill_per_sec))
        }
    }

    /// Forgets buckets that have refilled completely (they'd start full anyway).
    pub fn prune(&self) {
        let now = Instant::now();
        let full = self.capacity / self.refill_per_sec;
        self.buckets.retain(|_, (_, last)| now.duration_since(*last).as_secs_f64() < full);
    }
}

/// Limits requests per client address, as an axum middleware (`ip_limit`).
pub struct IpLimit {
    buckets: Buckets<IpAddr>,
    /// Behind a reverse proxy that sets `X-Forwarded-For` itself (Caddy in our compose files).
    trust_proxy: bool,
}

impl IpLimit {
    pub fn new(capacity: u32, per_secs: f64, trust_proxy: bool) -> Arc<Self> {
        let me = Arc::new(Self { buckets: Buckets::new(capacity, per_secs), trust_proxy });
        // Keep memory bounded by the clients active lately.
        let weak = Arc::downgrade(&me);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                loop {
                    tick.tick().await;
                    let Some(me) = weak.upgrade() else { return };
                    me.buckets.prune();
                }
            });
        }
        me
    }

    /// Whom to count a request against; None for requests that aren't limited.
    fn key(&self, peer: Option<SocketAddr>, headers: &HeaderMap) -> Option<IpAddr> {
        let peer = peer?.ip();
        let ip = if self.trust_proxy {
            // The proxy appends the address it saw, so only the last entry is trustworthy.
            let forwarded = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit(',').next()).and_then(|v| v.trim().parse().ok());
            forwarded.unwrap_or(peer)
        } else {
            peer
        };
        // Loopback: tests, health checks, or a same-host proxy that isn't trusted (where every
        // client would otherwise share one bucket).
        if ip.is_loopback() {
            return None;
        }
        Some(match ip {
            // One IPv6 client usually holds a whole /64.
            IpAddr::V6(v6) => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
            v4 => v4,
        })
    }
}

/// `axum::middleware::from_fn_with_state(limit, throttle::ip_limit)`; needs the server to run
/// with `into_make_service_with_connect_info::<SocketAddr>()`.
pub async fn ip_limit(State(limit): State<Arc<IpLimit>>, req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    if let Some(key) = limit.key(peer, req.headers())
        && let Some(wait) = limit.buckets.wait(key)
    {
        let mut res = (StatusCode::TOO_MANY_REQUESTS, "too many requests; try again shortly").into_response();
        res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(wait.as_secs().max(1)));
        return res;
    }
    next.run(req).await
}

/// `TRUST_PROXY=1`/`true`: client addresses come from `X-Forwarded-For`.
pub fn trust_proxy_from_env() -> bool {
    std::env::var("TRUST_PROXY").is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_run_out_and_refill() {
        let b = Buckets::new(2, 0.05);
        assert!(b.check(1));
        assert!(b.check(1));
        assert!(!b.check(1));
        assert!(b.check(2), "keys are separate");
        std::thread::sleep(Duration::from_millis(40));
        assert!(b.check(1));
    }

    #[test]
    fn client_address() {
        let peer: SocketAddr = "203.0.113.7:4000".parse().unwrap();
        let proxy: SocketAddr = "172.18.0.5:4000".parse().unwrap();
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "1.2.3.4, 198.51.100.9".parse().unwrap());
        let direct = IpLimit { buckets: Buckets::new(1, 1.0), trust_proxy: false };
        let proxied = IpLimit { buckets: Buckets::new(1, 1.0), trust_proxy: true };
        // Untrusted headers are ignored; behind a proxy the last hop counts, not a spoofed first one.
        assert_eq!(direct.key(Some(peer), &h), Some(peer.ip()));
        assert_eq!(proxied.key(Some(proxy), &h), Some("198.51.100.9".parse().unwrap()));
        assert_eq!(direct.key(Some("127.0.0.1:1".parse().unwrap()), &h), None);
        assert_eq!(direct.key(None, &h), None);
        let v6: SocketAddr = "[2001:db8:1:2:3:4:5:6]:1".parse().unwrap();
        assert_eq!(direct.key(Some(v6), &HeaderMap::new()), Some("2001:db8:1:2::".parse().unwrap()));
    }
}
