//! In-memory fan-out of gateway events.
//!
//! Every event is serialized exactly once and the resulting `Utf8Bytes` (an `Arc`'d buffer)
//! is cloned into each subscriber's bounded queue. A subscriber that cannot keep up is
//! disconnected rather than allowed to grow memory; clients resync on reconnect.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::Utf8Bytes;
use dashmap::DashMap;
use parking_lot::Mutex;
use proto::gateway::{ServerEvent, VoiceStateRef};
use proto::models::{Presence, Status, VoiceState};
use proto::Id;
use tokio::sync::mpsc;

pub const SESSION_QUEUE: usize = 2048;

pub type SessionKey = u64;

struct Session {
    user: Id,
    tx: mpsc::Sender<Utf8Bytes>,
    guilds: HashSet<Id>,
}

#[derive(Default)]
pub struct Hub {
    next: AtomicU64,
    sessions: DashMap<SessionKey, Session>,
    guild_sessions: DashMap<Id, HashSet<SessionKey>>,
    user_sessions: DashMap<Id, HashSet<SessionKey>>,
    /// Status and custom status of everyone online.
    status: DashMap<Id, (Status, Option<String>)>,
    /// guild -> user -> voice state
    voice: DashMap<Id, HashMap<Id, VoiceState>>,
    /// user -> (guild, owning session). A user is in at most one voice channel.
    voice_owner: Mutex<HashMap<Id, (Id, SessionKey)>>,
}

pub fn encode(ev: &ServerEvent) -> Utf8Bytes {
    Utf8Bytes::from(serde_json::to_string(ev).expect("events serialize"))
}

impl Hub {
    /// Registers a session. Returns its key and whether this is the user's first live session.
    /// A first session starts with `shown` (what the client last chose).
    pub fn connect(&self, user: Id, guilds: &[Id], tx: mpsc::Sender<Utf8Bytes>, shown: (Status, Option<String>)) -> (SessionKey, bool) {
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        for g in guilds {
            self.guild_sessions.entry(*g).or_default().insert(key);
        }
        self.sessions.insert(key, Session { user, tx, guilds: guilds.iter().copied().collect() });
        let mut us = self.user_sessions.entry(user).or_default();
        us.insert(key);
        let first = us.len() == 1;
        drop(us);
        if first {
            self.status.insert(user, shown);
        }
        (key, first)
    }

    /// Unregisters a session. Returns the guilds it was in and whether the user is now offline.
    pub fn disconnect(&self, key: SessionKey) -> Option<(Id, Vec<Id>, bool)> {
        let (_, s) = self.sessions.remove(&key)?;
        for g in &s.guilds {
            if let Some(mut set) = self.guild_sessions.get_mut(g) {
                set.remove(&key);
            }
        }
        let offline = match self.user_sessions.get_mut(&s.user) {
            Some(mut set) => {
                set.remove(&key);
                set.is_empty()
            }
            None => true,
        };
        if offline {
            self.user_sessions.remove_if(&s.user, |_, s| s.is_empty());
            self.status.remove(&s.user);
        }
        Some((s.user, s.guilds.into_iter().collect(), offline))
    }

    /// Every live session of `user`.
    pub fn session_keys(&self, user: Id) -> Vec<SessionKey> {
        self.user_sessions.get(&user).map(|s| s.iter().copied().collect()).unwrap_or_default()
    }

    /// Subscribes all sessions of `user` to `guild` (after joining/creating it).
    pub fn join_guild(&self, user: Id, guild: Id) {
        let keys: Vec<_> = self.user_sessions.get(&user).map(|s| s.iter().copied().collect()).unwrap_or_default();
        for k in keys {
            if let Some(mut s) = self.sessions.get_mut(&k) {
                s.guilds.insert(guild);
                self.guild_sessions.entry(guild).or_default().insert(k);
            }
        }
    }

    pub fn leave_guild(&self, user: Id, guild: Id) {
        let keys: Vec<_> = self.user_sessions.get(&user).map(|s| s.iter().copied().collect()).unwrap_or_default();
        for k in keys {
            if let Some(mut s) = self.sessions.get_mut(&k) {
                s.guilds.remove(&guild);
            }
            if let Some(mut set) = self.guild_sessions.get_mut(&guild) {
                set.remove(&k);
            }
        }
    }

    pub fn drop_guild(&self, guild: Id) {
        if let Some((_, keys)) = self.guild_sessions.remove(&guild) {
            for k in keys {
                if let Some(mut s) = self.sessions.get_mut(&k) {
                    s.guilds.remove(&guild);
                }
            }
        }
        self.voice.remove(&guild);
        self.voice_owner.lock().retain(|_, (g, _)| *g != guild);
    }

    fn send_raw(&self, key: SessionKey, msg: Utf8Bytes) {
        let overflow = match self.sessions.get(&key) {
            Some(s) => s.tx.try_send(msg).is_err(),
            None => false,
        };
        if overflow {
            // Dropping the only sender closes the session's queue, which ends its task.
            tracing::warn!(session = key, "gateway session queue full, disconnecting");
            self.sessions.remove(&key);
        }
    }

    pub fn to_session(&self, key: SessionKey, ev: &ServerEvent) {
        self.send_raw(key, encode(ev));
    }

    pub fn to_user(&self, user: Id, ev: &ServerEvent) {
        let keys: Vec<_> = match self.user_sessions.get(&user) {
            Some(s) => s.iter().copied().collect(),
            None => return,
        };
        let msg = encode(ev);
        for k in keys {
            self.send_raw(k, msg.clone());
        }
    }

    pub fn to_guild(&self, guild: Id, ev: &ServerEvent) {
        let keys: Vec<_> = match self.guild_sessions.get(&guild) {
            Some(s) => s.iter().copied().collect(),
            None => return,
        };
        let msg = encode(ev);
        for k in keys {
            self.send_raw(k, msg.clone());
        }
    }

    /// Like `to_guild`, but only to sessions whose user passes `allow` (e.g. can see a channel).
    pub fn to_guild_where(&self, guild: Id, ev: &ServerEvent, allow: impl Fn(Id) -> bool) {
        let keys: Vec<_> = match self.guild_sessions.get(&guild) {
            Some(s) => s.iter().copied().collect(),
            None => return,
        };
        let mut msg = None;
        for k in keys {
            let Some(user) = self.sessions.get(&k).map(|s| s.user) else { continue };
            if allow(user) {
                self.send_raw(k, msg.get_or_insert_with(|| encode(ev)).clone());
            }
        }
    }

    /// Users with a session in `guild`.
    pub fn guild_users(&self, guild: Id) -> Vec<Id> {
        let keys: Vec<_> = match self.guild_sessions.get(&guild) {
            Some(s) => s.iter().copied().collect(),
            None => return Vec::new(),
        };
        let mut users: Vec<Id> = keys.iter().filter_map(|k| self.sessions.get(k).map(|s| s.user)).collect();
        users.sort_unstable();
        users.dedup();
        users
    }

    pub fn status(&self, user: Id) -> Status {
        self.status.get(&user).map(|s| s.0).unwrap_or(Status::Offline)
    }

    /// What others see of `user`, if online.
    pub fn presence(&self, user: Id) -> Option<Presence> {
        self.status.get(&user).map(|s| Presence { user_id: user, status: s.0, custom: s.1.clone() })
    }

    /// Returns whether anything changed.
    pub fn set_status(&self, user: Id, status: Status, custom: Option<String>) -> bool {
        match self.status.get_mut(&user) {
            Some(mut s) if s.0 != status || s.1 != custom => {
                *s = (status, custom);
                true
            }
            _ => false,
        }
    }

    pub fn presences(&self, users: impl Iterator<Item = Id>) -> Vec<Presence> {
        users.filter_map(|u| self.presence(u)).collect()
    }

    pub fn voice_states(&self, guild: Id) -> Vec<VoiceState> {
        self.voice.get(&guild).map(|m| m.values().cloned().collect()).unwrap_or_default()
    }

    pub fn voice_state(&self, guild: Id, user: Id) -> Option<VoiceState> {
        self.voice.get(&guild).and_then(|m| m.get(&user).cloned())
    }

    /// Sets a user's voice state, evicting any state they had elsewhere.
    /// Returns the guild of the evicted state, if it was in a different guild.
    pub fn set_voice(&self, session: SessionKey, state: VoiceState) -> Option<Id> {
        let user = state.user_id;
        let guild = state.guild_id;
        let prev = self.voice_owner.lock().insert(user, (guild, session));
        let mut evicted = None;
        if let Some((pg, _)) = prev
            && pg != guild
        {
            if let Some(mut m) = self.voice.get_mut(&pg) {
                m.remove(&user);
            }
            evicted = Some(pg);
        }
        self.voice.entry(guild).or_default().insert(user, state);
        evicted
    }

    /// Removes a user's voice state. When `only_session` is set, only removes it if that
    /// session owns it (so a second tab disconnecting doesn't kick the first out of voice).
    pub fn clear_voice(&self, user: Id, only_session: Option<SessionKey>) -> Option<VoiceStateRef> {
        let mut owners = self.voice_owner.lock();
        let (guild, owner) = *owners.get(&user)?;
        if only_session.is_some_and(|s| s != owner) {
            return None;
        }
        owners.remove(&user);
        drop(owners);
        if let Some(mut m) = self.voice.get_mut(&guild) {
            m.remove(&user);
        }
        Some(VoiceStateRef { guild_id: guild, user_id: user })
    }
}
