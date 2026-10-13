//! Control-plane state shared by all workers.
//!
//! Peers of one room may live on different workers (so a big room uses many cores). Media
//! never takes these locks: frames move between workers over channels, and per-track
//! subscriber counts are atomics. The mutexes here are only touched on joins, publishes,
//! subscriptions and the periodic layer allocation.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use parking_lot::Mutex;
use proto::Id;
use proto::voice::{MediaKind as WireKind, TrackInfo, TrackSource, VoiceServerMsg};
use str0m::media::{MediaKind, Mid, Rid};
use tokio::sync::mpsc;

use crate::worker::{Cmd, PeerId};

pub type LayerKey = (Mid, Option<Rid>);

pub struct Shared {
    pub rooms: Mutex<HashMap<Id, Room>>,
    pub workers: Vec<mpsc::UnboundedSender<Cmd>>,
    /// Peers per worker, for least-loaded placement.
    pub load: Vec<AtomicUsize>,
    /// The address advertised to clients; it can change (a home connection's IP).
    pub public_ip: parking_lot::RwLock<std::net::IpAddr>,
}

#[derive(Default)]
pub struct Room {
    pub peers: HashMap<PeerId, RoomPeer>,
    pub tracks: HashMap<Arc<str>, Arc<Track>>,
}

pub struct RoomPeer {
    pub user: Id,
    pub worker: usize,
    pub out: mpsc::UnboundedSender<VoiceServerMsg>,
}

/// A published track as seen by every worker.
pub struct Track {
    pub id: Arc<str>,
    pub owner: PeerId,
    pub owner_worker: usize,
    pub user: Id,
    pub kind: MediaKind,
    pub source: TrackSource,
    /// Best quality first, with layer names.
    pub layers: Mutex<Vec<(LayerKey, String)>>,
    /// Measured bitrate per layer, written by the owner's worker.
    pub rates: Mutex<HashMap<LayerKey, u64>>,
    /// Local subscribers per worker; frames are only shipped to workers with > 0.
    pub sub_workers: Vec<AtomicU32>,
}

impl Track {
    pub fn info(&self) -> TrackInfo {
        let layers = self.layers.lock();
        TrackInfo {
            id: self.id.to_string(),
            user_id: self.user,
            kind: if self.kind == MediaKind::Audio { WireKind::Audio } else { WireKind::Video },
            source: self.source,
            layers: if layers.len() > 1 { layers.iter().map(|l| l.1.clone()).collect() } else { vec![] },
        }
    }

    pub fn layer_name(&self, key: LayerKey) -> Option<String> {
        let layers = self.layers.lock();
        if layers.len() < 2 {
            return None;
        }
        layers.iter().find(|l| l.0 == key).map(|l| l.1.clone())
    }

    pub fn has_subscribers_on(&self, worker: usize) -> bool {
        self.sub_workers[worker].load(Ordering::Relaxed) > 0
    }
}

impl Shared {
    pub fn new(workers: Vec<mpsc::UnboundedSender<Cmd>>) -> Self {
        let load = workers.iter().map(|_| AtomicUsize::new(0)).collect();
        Self { rooms: Mutex::new(HashMap::new()), workers, load, public_ip: parking_lot::RwLock::new([127, 0, 0, 1].into()) }
    }

    pub fn least_loaded(&self) -> usize {
        (0..self.load.len()).min_by_key(|i| self.load[*i].load(Ordering::Relaxed)).unwrap_or(0)
    }

    pub fn send(&self, worker: usize, cmd: Cmd) {
        let _ = self.workers[worker].send(cmd);
    }

    pub fn broadcast(&self, room: Id, except: Option<PeerId>, msg: VoiceServerMsg) {
        let rooms = self.rooms.lock();
        let Some(r) = rooms.get(&room) else { return };
        for (pid, p) in &r.peers {
            if Some(*pid) != except {
                let _ = p.out.send(msg.clone());
            }
        }
    }
}
