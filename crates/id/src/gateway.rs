//! branchr ID's gateway: one WebSocket per signed-in device, for friends, presence and DMs.
//! The first message must identify with an access token; READY follows.

use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message as WsMsg, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use proto::social::{SocialEvent, SocialOp, SocialPresence, SocialReady};
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout};
use uuid::Uuid;

use crate::AppState;
use crate::hub::{QUEUE, encode};
use crate::oauth::{AUDIENCE, AccessClaims};
use crate::social;

/// Clients heartbeat at least this often (they send one every 30 s).
const IDLE: Duration = Duration::from_secs(75);

pub async fn upgrade(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = run(socket, s).await {
            tracing::debug!("gateway session ended: {e:#}");
        }
    })
}

async fn send(ws: &mut WebSocket, ev: &SocialEvent) -> anyhow::Result<()> {
    ws.send(WsMsg::Text(encode(ev))).await?;
    Ok(())
}

async fn identify(ws: &mut WebSocket, s: &AppState) -> anyhow::Result<Option<Uuid>> {
    let msg = timeout(Duration::from_secs(15), ws.recv()).await?.ok_or_else(|| anyhow::anyhow!("closed"))??;
    let WsMsg::Text(t) = msg else { return Ok(None) };
    let Ok(SocialOp::Identify { token }) = serde_json::from_str::<SocialOp>(&t) else { return Ok(None) };
    let claims: Option<AccessClaims> = s.keys.verify(&token, &s.config.public_url, AUDIENCE);
    Ok(claims.and_then(|c| c.sub.parse().ok()).filter(|id| !s.banned.contains(id)))
}

async fn set_presence(s: &AppState, me: Uuid, online: bool) {
    match social::friends(s, me).await {
        Ok(friends) => {
            let ev = SocialEvent::PresenceUpdate(SocialPresence { id: me.to_string(), online });
            for f in friends {
                s.hub.send(f, &ev);
            }
        }
        Err(e) => tracing::warn!("presence for {me}: {e}"),
    }
}

async fn run(mut ws: WebSocket, s: AppState) -> anyhow::Result<()> {
    let Some(me) = identify(&mut ws, &s).await? else {
        let _ = ws.send(WsMsg::Close(Some(axum::extract::ws::CloseFrame { code: 4004, reason: "unauthorized".into() }))).await;
        return Ok(());
    };
    let (tx, mut rx) = mpsc::channel::<Utf8Bytes>(QUEUE);
    // Registered before READY is built, so nothing falls between the snapshot and the stream.
    let (key, first) = s.hub.connect(me, tx);
    let _guard = Guard { s: s.clone(), me, key };

    let (person, relationships, channels) =
        tokio::try_join!(social::person(&s, me), social::relationships_of(&s, me), social::channels_of(&s, me)).map_err(|e| anyhow::anyhow!("{e}"))?;
    let online = relationships
        .iter()
        .filter(|r| r.kind == proto::social::RelationshipKind::Friend)
        .filter(|r| r.person.id.parse().is_ok_and(|id| s.hub.online(id)))
        .map(|r| r.person.id.clone())
        .collect();
    let calls = s.calls.in_channels(&channels.iter().map(|c| c.id.0).collect::<Vec<_>>());
    send(&mut ws, &SocialEvent::Ready(SocialReady { me: person, relationships, channels, online, calls })).await?;
    if first {
        set_presence(&s, me, true).await;
    }

    let mut deadline = Instant::now() + IDLE;
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(m) => ws.send(WsMsg::Text(m)).await?,
                None => break,
            },
            msg = ws.recv() => {
                let Some(msg) = msg else { break };
                match msg? {
                    WsMsg::Text(t) => {
                        deadline = Instant::now() + IDLE;
                        match serde_json::from_str::<SocialOp>(&t) {
                            Ok(SocialOp::Heartbeat) => send(&mut ws, &SocialEvent::HeartbeatAck).await?,
                            Ok(SocialOp::Typing { channel_id }) => { let _ = social::typing(&s, me, channel_id).await; }
                            Ok(SocialOp::Ack { channel_id, message_id }) => { let _ = social::ack(&s, me, channel_id, message_id).await; }
                            _ => {}
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

/// Ends the session however the task exits, and announces going offline.
struct Guard {
    s: AppState,
    me: Uuid,
    key: u64,
}

impl Drop for Guard {
    fn drop(&mut self) {
        if self.s.hub.disconnect(self.me, self.key) {
            let (s, me) = (self.s.clone(), self.me);
            tokio::spawn(async move {
                // A quick reconnect (a reload) shouldn't flash offline.
                tokio::time::sleep(Duration::from_secs(3)).await;
                if !s.hub.online(me) {
                    set_presence(&s, me, false).await;
                    // Gone for good: out of any call too.
                    for channel in s.calls.drop_account(me) {
                        let _ = crate::calls::announce(&s, channel).await;
                    }
                }
            });
        }
    }
}
