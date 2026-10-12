//! WebSocket gateway: identify, READY snapshot, then a bidirectional event stream.

use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message as WsMsg, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures::future::try_join_all;
use proto::gateway::*;
use proto::models::*;
use proto::voice::VoiceClaims;
use proto::Id;
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout};

use crate::db;
use crate::hub::{SESSION_QUEUE, SessionKey, encode};
use crate::state::AppState;

const HEARTBEAT_MS: u32 = 30_000;

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(64 * 1024).on_upgrade(move |socket| async move {
        if let Err(e) = run(socket, state).await {
            tracing::debug!("gateway session ended: {e:#}");
        }
    })
}

async fn send(ws: &mut WebSocket, ev: &ServerEvent) -> anyhow::Result<()> {
    ws.send(WsMsg::Text(encode(ev))).await?;
    Ok(())
}

pub async fn ready_guild(state: &AppState, guild: Id) -> anyhow::Result<ReadyGuild> {
    let (g, channels, members, emotes) = tokio::try_join!(
        db::guild(&state.db, guild),
        db::channels(&state.db, guild),
        db::members(&state.db, guild),
        db::emotes(&state.db, guild),
    )?;
    for c in &channels {
        state.channel_guild.insert(c.id, guild);
    }
    let presences = state.hub.presences(members.iter().map(|m| m.user.id));
    Ok(ReadyGuild { guild: g, channels, members, emotes, voice_states: state.hub.voice_states(guild), presences })
}

async fn run(mut ws: WebSocket, state: AppState) -> anyhow::Result<()> {
    send(&mut ws, &ServerEvent::Hello(Hello { heartbeat_interval_ms: HEARTBEAT_MS })).await?;

    // Identify must arrive promptly.
    let user = loop {
        let msg = timeout(Duration::from_secs(15), ws.recv()).await?.ok_or_else(|| anyhow::anyhow!("closed"))??;
        if let WsMsg::Text(t) = msg {
            if let Ok(ClientOp::Identify { token }) = serde_json::from_str::<ClientOp>(&t) {
                match crate::auth::user_for_token(&state, &token).await {
                    Ok(Some(u)) => break u,
                    _ => {
                        send(&mut ws, &ServerEvent::InvalidSession).await?;
                        return Ok(());
                    }
                }
            }
        }
    };

    let guild_ids = db::guild_ids_for_user(&state.db, user).await?;
    let (tx, mut rx) = mpsc::channel::<Utf8Bytes>(SESSION_QUEUE);
    // Register before building READY so no event can fall between snapshot and stream.
    let (key, first) = state.hub.connect(user, &guild_ids, tx);
    let _guard = SessionGuard { state: state.clone(), key };

    let me = db::user(&state.db, user).await?;
    let (guilds, read_states) = tokio::try_join!(
        try_join_all(guild_ids.iter().map(|g| ready_guild(&state, *g))),
        async { Ok(db::read_states(&state.db, user).await?) },
    )?;
    let ready = Ready { user: me, session_id: key.to_string(), guilds, max_upload_bytes: state.config.max_upload_bytes, read_states };
    send(&mut ws, &ServerEvent::Ready(ready)).await?;

    if first {
        broadcast_presence(&state, user, Status::Online, &guild_ids);
    }

    let hb_timeout = Duration::from_millis(HEARTBEAT_MS as u64 * 2);
    let mut deadline = Instant::now() + hb_timeout;
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(m) => ws.send(WsMsg::Text(m)).await?,
                None => break, // evicted by hub (slow consumer)
            },
            msg = ws.recv() => {
                let Some(msg) = msg else { break };
                match msg? {
                    WsMsg::Text(t) => {
                        let Ok(op) = serde_json::from_str::<ClientOp>(&t) else { continue };
                        if matches!(op, ClientOp::Heartbeat) {
                            deadline = Instant::now() + hb_timeout;
                            send(&mut ws, &ServerEvent::HeartbeatAck).await?;
                        } else {
                            handle_op(&state, key, user, op).await;
                        }
                    }
                    WsMsg::Close(_) => break,
                    _ => {}
                }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
    Ok(())
}

fn broadcast_presence(state: &AppState, user: Id, status: Status, guilds: &[Id]) {
    let ev = ServerEvent::PresenceUpdate(Presence { user_id: user, status });
    for g in guilds {
        state.hub.to_guild(*g, &ev);
    }
}

/// Cleans up hub state however the session task exits.
struct SessionGuard {
    state: AppState,
    key: SessionKey,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        end_session(&self.state, self.key);
    }
}

/// Removes a session from the hub (leaving voice, going offline if it was the last one).
/// Its socket loop then ends, since the hub held its only sender.
fn end_session(state: &AppState, key: SessionKey) {
    let hub = &state.hub;
    let Some((user, guilds, offline)) = hub.disconnect(key) else { return };
    if let Some(r) = hub.clear_voice(user, Some(key)) {
        hub.to_guild(r.guild_id, &ServerEvent::VoiceStateRemove(r));
    }
    if offline {
        broadcast_presence(state, user, Status::Offline, &guilds);
    }
}

/// Disconnects every session of `user` (e.g. banned from the host).
pub fn evict_user(state: &AppState, user: Id) {
    for key in state.hub.session_keys(user) {
        end_session(state, key);
    }
}

async fn handle_op(state: &AppState, key: SessionKey, user: Id, op: ClientOp) {
    match op {
        ClientOp::Typing { channel_id } => {
            let Ok(guild) = state.guild_of_channel(channel_id).await else { return };
            if db::is_member(&state.db, guild, user).await.unwrap_or(false) {
                state.hub.to_guild(guild, &ServerEvent::TypingStart(TypingStart { channel_id, user_id: user }));
            }
        }
        ClientOp::SetStatus { status } => {
            let status = if status == Status::Offline { Status::Idle } else { status };
            if state.hub.set_status(user, status) {
                let guilds = db::guild_ids_for_user(&state.db, user).await.unwrap_or_default();
                broadcast_presence(state, user, status, &guilds);
            }
        }
        ClientOp::VoiceStateUpdate(u) => voice_state_update(state, key, user, u).await,
        ClientOp::Ack { channel_id, message_id } => {
            let Ok(guild) = state.guild_of_channel(channel_id).await else { return };
            if !db::is_member(&state.db, guild, user).await.unwrap_or(false) {
                return;
            }
            match db::ack(&state.db, user, channel_id, message_id).await {
                Ok(rs) => state.hub.to_user(user, &ServerEvent::ReadStateUpdate(rs)),
                Err(e) => tracing::warn!("ack: {e}"),
            }
        }
        ClientOp::Identify { .. } | ClientOp::Heartbeat => {}
    }
}

async fn voice_state_update(state: &AppState, key: SessionKey, user: Id, u: VoiceStateUpdate) {
    let hub = &state.hub;
    let Some(channel_id) = u.channel_id else {
        if let Some(r) = hub.clear_voice(user, None) {
            hub.to_guild(r.guild_id, &ServerEvent::VoiceStateRemove(r));
        }
        return;
    };

    let Ok(channel) = db::channel(&state.db, channel_id).await else { return };
    if channel.guild_id != u.guild_id || channel.kind != ChannelKind::Voice {
        return;
    }
    if !db::is_member(&state.db, u.guild_id, user).await.unwrap_or(false) {
        return;
    }

    let prev = hub.voice_state(u.guild_id, user);
    let vs = VoiceState {
        user_id: user,
        guild_id: u.guild_id,
        channel_id,
        self_mute: u.self_mute,
        self_deaf: u.self_deaf,
        self_video: u.self_video,
        self_stream: u.self_stream,
    };
    if let Some(old_guild) = hub.set_voice(key, vs.clone()) {
        hub.to_guild(old_guild, &ServerEvent::VoiceStateRemove(VoiceStateRef { guild_id: old_guild, user_id: user }));
    }
    hub.to_guild(u.guild_id, &ServerEvent::VoiceStateUpdate(vs));

    if prev.map(|p| p.channel_id) != Some(channel_id) {
        let claims = VoiceClaims {
            user_id: user,
            guild_id: u.guild_id,
            channel_id,
            exp: (db::now_ms() / 1000) as u64 + 120,
        };
        let urls = &state.config.sfu_urls;
        let endpoint = urls[(channel_id.0 as u64 % urls.len() as u64) as usize].clone();
        hub.to_session(
            key,
            &ServerEvent::VoiceServer(VoiceServer {
                endpoint,
                token: proto::voice::token::sign(&state.config.voice_secret, &claims),
                guild_id: u.guild_id,
                channel_id,
            }),
        );
    }
}
