//! WebSocket signaling. Each socket is one peer; messages are relayed to the worker
//! that owns the peer's room.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use proto::voice::{VoiceClientMsg, VoiceServerMsg};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::shared::Shared;
use crate::worker::{Cmd, PeerId};

pub struct App {
    config: Config,
    shared: Arc<Shared>,
    next_peer: AtomicU64,
}

impl App {
    pub fn new(config: Config, shared: Arc<Shared>) -> Self {
        Self { config, shared, next_peer: AtomicU64::new(1) }
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new().route("/ws", get(upgrade)).route("/health", get(|| async { "ok" })).with_state(app)
}

async fn upgrade(ws: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    ws.max_message_size(256 * 1024).on_upgrade(move |s| async move {
        if let Err(e) = run(s, app).await {
            tracing::debug!("signaling ended: {e:#}");
        }
    })
}

async fn send(ws: &mut WebSocket, msg: &VoiceServerMsg) -> anyhow::Result<()> {
    ws.send(Message::Text(serde_json::to_string(msg)?.into())).await?;
    Ok(())
}

async fn run(mut ws: WebSocket, app: Arc<App>) -> anyhow::Result<()> {
    let claims = loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.recv())
            .await?
            .ok_or_else(|| anyhow::anyhow!("closed"))??;
        if let Message::Text(t) = msg
            && let Ok(VoiceClientMsg::Join { token }) = serde_json::from_str(&t)
        {
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            match proto::voice::token::verify(&app.config.voice_secret, &token, now) {
                Some(c) => break c,
                None => {
                    send(&mut ws, &VoiceServerMsg::Error { message: "invalid token".into() }).await?;
                    return Ok(());
                }
            }
        }
    };

    let peer = PeerId(app.next_peer.fetch_add(1, Ordering::Relaxed));
    // Peers go to the least loaded worker regardless of room, so big rooms use every core.
    let worker = app.shared.least_loaded();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel();
    app.shared.send(worker, Cmd::Join { peer, user: claims.user_id, room: claims.channel_id, claims: claims.clone(), out: out_tx });
    let _leave = LeaveGuard { shared: app.shared.clone(), worker, peer };

    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(m) => send(&mut ws, &m).await?,
                None => break, // worker dropped the peer
            },
            msg = ws.recv() => {
                let Some(msg) = msg else { break };
                match msg? {
                    Message::Text(t) => match serde_json::from_str::<VoiceClientMsg>(&t) {
                        Ok(VoiceClientMsg::Ping) => send(&mut ws, &VoiceServerMsg::Pong).await?,
                        Ok(VoiceClientMsg::Join { .. }) => {}
                        Ok(msg) => app.shared.send(worker, Cmd::Msg { peer, msg }),
                        Err(e) => send(&mut ws, &VoiceServerMsg::Error { message: format!("bad message: {e}") }).await?,
                    },
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

struct LeaveGuard {
    shared: Arc<Shared>,
    worker: usize,
    peer: PeerId,
}

impl Drop for LeaveGuard {
    fn drop(&mut self) {
        self.shared.send(self.worker, Cmd::Leave { peer: self.peer });
    }
}
