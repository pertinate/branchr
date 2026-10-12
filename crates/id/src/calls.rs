//! Calls in DMs, carried by an SFU next to branchr ID (the same one instances use). branchr ID
//! hands out voice tokens and keeps who's in each call and who's being rung; everyone in the
//! conversation hears about it on the gateway.

use std::collections::HashSet;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use dashmap::DashMap;
use proto::Id;
use proto::social::{CallJoin, CallParticipant, CallState, RelationshipKind, SocialEvent};
use proto::voice::VoiceClaims;
use uuid::Uuid;

use crate::AppState;
use crate::error::{Error, Result};
use crate::oauth::authed;
use crate::social;

/// How long a call rings before giving up on those who haven't answered.
const RING: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Call {
    participants: HashSet<Uuid>,
    ringing: HashSet<Uuid>,
}

#[derive(Default)]
pub struct Calls {
    calls: DashMap<i64, Call>,
}

/// The id the SFU knows an account by (it speaks in integer ids, accounts are UUIDs).
pub fn voice_id(account: Uuid) -> Id {
    let (hi, lo) = account.as_u64_pair();
    Id(((hi ^ lo) & i64::MAX as u64) as i64)
}

impl Calls {
    pub fn state(&self, channel: i64) -> CallState {
        let (participants, ringing) = self
            .calls
            .get(&channel)
            .map(|c| (c.participants.iter().copied().collect::<Vec<_>>(), c.ringing.iter().map(Uuid::to_string).collect()))
            .unwrap_or_default();
        CallState {
            channel_id: Id(channel),
            participants: participants.into_iter().map(|p| CallParticipant { id: p.to_string(), voice_id: voice_id(p) }).collect(),
            ringing,
        }
    }

    /// Calls in any of `channels`.
    pub fn in_channels(&self, channels: &[i64]) -> Vec<CallState> {
        channels.iter().filter(|c| self.calls.contains_key(c)).map(|c| self.state(*c)).collect()
    }

    /// Takes `account` out of one call (they left the conversation).
    pub fn drop_from(&self, channel: i64, account: Uuid) {
        let empty = self.calls.get_mut(&channel).is_some_and(|mut c| {
            c.participants.remove(&account);
            c.ringing.remove(&account);
            c.participants.is_empty()
        });
        if empty {
            self.calls.remove(&channel);
        }
    }

    /// Takes `account` out of every call (they went offline); returns the calls that changed.
    pub fn drop_account(&self, account: Uuid) -> Vec<i64> {
        let mut changed = Vec::new();
        self.calls.retain(|id, c| {
            if c.participants.remove(&account) | c.ringing.remove(&account) {
                changed.push(*id);
            }
            !c.participants.is_empty()
        });
        changed
    }
}

/// Tells everyone in the conversation how its call stands.
pub async fn announce(s: &AppState, channel: i64) -> Result<()> {
    let state = s.calls.state(channel);
    for m in social::members(s, channel).await? {
        s.hub.send(m, &SocialEvent::CallUpdate(state.clone()));
    }
    Ok(())
}

/// Joins (or starts) the conversation's call, returning where to connect.
pub async fn join(State(s): State<AppState>, headers: HeaderMap, Path(cid): Path<Id>) -> Result<Json<CallJoin>> {
    let me = authed(&s, &headers).await?;
    let (Some(endpoint), Some(secret)) = (s.config.sfu_url.clone(), s.config.voice_secret.clone()) else {
        return Err(Error::Forbidden("calls aren't set up on this branchr ID".into()));
    };
    let members = social::member_of_channel(&s, me, cid).await?;
    // One-to-one, a block either way stops calls like it stops messages.
    if members.len() == 2 && !social::is_group(&s, cid).await? {
        let other = *members.iter().find(|m| **m != me).expect("two members");
        if social::kind_of(&s, me, other).await? == Some(RelationshipKind::Blocked) || social::kind_of(&s, other, me).await? == Some(RelationshipKind::Blocked) {
            return Err(Error::Forbidden("you can't call them".into()));
        }
    }
    let started = {
        let mut call = s.calls.calls.entry(cid.0).or_default();
        let started = call.participants.is_empty();
        if started {
            call.ringing = members.iter().copied().filter(|m| *m != me).collect();
        }
        call.ringing.remove(&me);
        call.participants.insert(me);
        started
    };
    if started {
        let s2 = s.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RING).await;
            let stopped = s2.calls.calls.get_mut(&cid.0).is_some_and(|mut c| {
                let had = !c.ringing.is_empty();
                c.ringing.clear();
                had
            });
            if stopped {
                let _ = announce(&s2, cid.0).await;
            }
        });
    }
    announce(&s, cid.0).await?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let claims = VoiceClaims {
        user_id: voice_id(me),
        guild_id: cid,
        channel_id: cid,
        exp: now + 120,
        deny_speak: false,
        deny_video: false,
        deny_stream: false,
    };
    Ok(Json(CallJoin { endpoint, token: proto::voice::token::sign(&secret, &claims), voice_id: voice_id(me) }))
}

pub async fn leave(State(s): State<AppState>, headers: HeaderMap, Path(cid): Path<Id>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    social::member_of_channel(&s, me, cid).await?;
    let gone = s.calls.calls.get_mut(&cid.0).is_some_and(|mut c| {
        c.participants.remove(&me);
        c.participants.is_empty()
    });
    if gone {
        s.calls.calls.remove(&cid.0);
    }
    announce(&s, cid.0).await
}

/// Stops ringing for you (you didn't pick up).
pub async fn decline(State(s): State<AppState>, headers: HeaderMap, Path(cid): Path<Id>) -> Result<()> {
    let me = authed(&s, &headers).await?;
    social::member_of_channel(&s, me, cid).await?;
    if let Some(mut c) = s.calls.calls.get_mut(&cid.0) {
        c.ringing.remove(&me);
    }
    announce(&s, cid.0).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_ids_are_stable_and_positive() {
        let a = Uuid::now_v7();
        assert_eq!(voice_id(a), voice_id(a));
        assert!(voice_id(a).0 >= 0);
        assert_ne!(voice_id(a), voice_id(Uuid::now_v7()));
    }
}
