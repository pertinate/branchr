use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Custom epoch (2025-01-01T00:00:00Z) in ms.
pub const EPOCH_MS: u64 = 1_735_689_600_000;

/// Snowflake id: 42 bits ms timestamp | 10 bits worker | 12 bits sequence.
/// Serialized as a string so JS never loses precision.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, type = "string"))]
pub struct Id(pub i64);

impl Id {
    pub fn timestamp_ms(self) -> u64 {
        ((self.0 as u64) >> 22) + EPOCH_MS
    }
}

impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for Id {
    type Err = std::num::ParseIntError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse().map(Id)
    }
}

impl Serialize for Id {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw<'a> {
            S(&'a str),
            Owned(String),
            N(i64),
        }
        match Raw::deserialize(d)? {
            Raw::S(s) => s.parse().map(Id).map_err(serde::de::Error::custom),
            Raw::Owned(s) => s.parse().map(Id).map_err(serde::de::Error::custom),
            Raw::N(n) => Ok(Id(n)),
        }
    }
}

/// Lock-free snowflake generator.
pub struct IdGen {
    worker: u64,
    /// (ms << 12) | seq of the last issued id.
    last: AtomicU64,
}

impl IdGen {
    pub const fn new(worker: u16) -> Self {
        Self { worker: (worker as u64) & 0x3ff, last: AtomicU64::new(0) }
    }

    pub fn next(&self) -> Id {
        loop {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 - EPOCH_MS;
            let last = self.last.load(Ordering::Relaxed);
            let (last_ms, last_seq) = (last >> 12, last & 0xfff);
            let next = if now > last_ms {
                now << 12
            } else if last_seq < 0xfff {
                (last_ms << 12) | (last_seq + 1)
            } else {
                // Sequence exhausted for this ms; borrow the next ms.
                (last_ms + 1) << 12
            };
            if self.last.compare_exchange_weak(last, next, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
                let (ms, seq) = (next >> 12, next & 0xfff);
                return Id(((ms << 22) | (self.worker << 12) | seq) as i64);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monotonic_and_unique() {
        let g = IdGen::new(1);
        let mut prev = g.next();
        for _ in 0..100_000 {
            let n = g.next();
            assert!(n > prev);
            prev = n;
        }
    }

    #[test]
    fn serde_string() {
        let id = Id(1234567890123456789);
        let s = serde_json::to_string(&id).unwrap();
        assert_eq!(s, "\"1234567890123456789\"");
        assert_eq!(serde_json::from_str::<Id>(&s).unwrap(), id);
    }
}
