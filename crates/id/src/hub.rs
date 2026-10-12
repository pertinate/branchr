//! Live sessions on branchr ID's gateway, by account.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::Utf8Bytes;
use dashmap::DashMap;
use proto::social::SocialEvent;
use tokio::sync::mpsc;
use uuid::Uuid;

/// Events queued per session before a slow one is dropped.
pub const QUEUE: usize = 512;

#[derive(Default)]
pub struct Hub {
    sessions: DashMap<Uuid, Vec<(u64, mpsc::Sender<Utf8Bytes>)>>,
    next: AtomicU64,
}

pub fn encode(ev: &SocialEvent) -> Utf8Bytes {
    serde_json::to_string(ev).expect("events serialize").into()
}

impl Hub {
    /// Registers a session; true if it's the account's first (they just came online).
    pub fn connect(&self, account: Uuid, tx: mpsc::Sender<Utf8Bytes>) -> (u64, bool) {
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        let mut list = self.sessions.entry(account).or_default();
        list.push((key, tx));
        (key, list.len() == 1)
    }

    /// Drops a session; true if it was the account's last (they went offline).
    pub fn disconnect(&self, account: Uuid, key: u64) -> bool {
        let mut last = false;
        self.sessions.remove_if_mut(&account, |_, list| {
            list.retain(|(k, _)| *k != key);
            last = list.is_empty();
            last
        });
        last
    }

    pub fn online(&self, account: Uuid) -> bool {
        self.sessions.contains_key(&account)
    }

    pub fn send(&self, account: Uuid, ev: &SocialEvent) {
        let Some(list) = self.sessions.get(&account) else { return };
        let msg = encode(ev);
        for (_, tx) in list.iter() {
            // A full queue means a stuck client; it reconnects and gets a fresh READY.
            let _ = tx.try_send(msg.clone());
        }
    }
}
