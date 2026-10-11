use std::time::Instant;

use dashmap::DashMap;
use proto::Id;

/// Per-key token bucket.
pub struct RateLimiter {
    capacity: f64,
    refill_per_sec: f64,
    buckets: DashMap<Id, (f64, Instant)>,
}

impl RateLimiter {
    pub fn new(capacity: u32, per_secs: f64) -> Self {
        Self { capacity: capacity as f64, refill_per_sec: capacity as f64 / per_secs, buckets: DashMap::new() }
    }

    pub fn check(&self, key: Id) -> bool {
        let now = Instant::now();
        let mut b = self.buckets.entry(key).or_insert((self.capacity, now));
        let (tokens, last) = *b;
        let tokens = (tokens + now.duration_since(last).as_secs_f64() * self.refill_per_sec).min(self.capacity);
        if tokens >= 1.0 {
            *b = (tokens - 1.0, now);
            true
        } else {
            *b = (tokens, now);
            false
        }
    }
}
