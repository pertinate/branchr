use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::{MessageRef, ReactionEvent, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::channel_access;
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

const MAX_LEN: usize = 4000;

#[derive(Deserialize)]
pub struct ListQuery {
    before: Option<Id>,
    after: Option<Id>,
    limit: Option<u32>,
}

pub async fn list(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<Message>>> {
    channel_access(&state, cid, user).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    Ok(Json(db::messages(&state.db, cid, q.before, q.after, limit, user).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessage {
    #[serde(default)]
    content: String,
    nonce: Option<String>,
    reply_to: Option<Id>,
    #[serde(default)]
    attachment_ids: Vec<Id>,
}

pub async fn create(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    Json(body): Json<CreateMessage>,
) -> AppResult<Json<Message>> {
    if !state.message_limiter.check(user) {
        return Err(AppError::TooManyRequests);
    }
    let guild = channel_access(&state, cid, user).await?;
    let content = body.content.trim();
    if (content.is_empty() && body.attachment_ids.is_empty()) || content.chars().count() > MAX_LEN {
        return Err(bad(format!("message must be 1-{MAX_LEN} characters")));
    }
    if body.attachment_ids.len() > 10 {
        return Err(bad("at most 10 attachments per message"));
    }
    if body.nonce.as_ref().is_some_and(|n| n.len() > 64) {
        return Err(bad("nonce too long"));
    }
    let id = state.ids.next();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, reply_to) VALUES (?, ?, ?, ?, ?)")
        .bind(id.0)
        .bind(cid.0)
        .bind(user.0)
        .bind(content)
        .bind(body.reply_to.map(|r| r.0))
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE channels SET last_message_id = ? WHERE id = ?").bind(id.0).bind(cid.0).execute(&mut *tx).await?;
    for a in &body.attachment_ids {
        // Only the uploader's own, unsent uploads to this channel can be attached.
        let r = sqlx::query("UPDATE attachments SET message_id = ? WHERE id = ? AND uploader_id = ? AND channel_id = ? AND message_id IS NULL")
            .bind(id.0)
            .bind(a.0)
            .bind(user.0)
            .bind(cid.0)
            .execute(&mut *tx)
            .await?;
        if r.rows_affected() == 0 {
            return Err(bad("unknown attachment"));
        }
    }
    tx.commit().await?;

    let msg = Message {
        id,
        channel_id: cid,
        author: db::user(&state.db, user).await?,
        content: content.to_string(),
        edited_at: None,
        reply_to: body.reply_to,
        reactions: vec![],
        attachments: db::attachments_for(&state.db, std::iter::once(id.0)).await?.remove(&id.0).unwrap_or_default(),
        nonce: body.nonce,
    };
    state.hub.to_guild(guild, &ServerEvent::MessageCreate(msg.clone()));
    Ok(Json(msg))
}

#[derive(Deserialize)]
pub struct EditMessage {
    content: String,
}

pub async fn edit(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid)): Path<(Id, Id)>,
    Json(body): Json<EditMessage>,
) -> AppResult<Json<Message>> {
    let guild = channel_access(&state, cid, user).await?;
    let content = body.content.trim();
    if content.is_empty() || content.chars().count() > MAX_LEN {
        return Err(bad(format!("message must be 1-{MAX_LEN} characters")));
    }
    let r = sqlx::query("UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND channel_id = ? AND author_id = ?")
        .bind(content)
        .bind(db::now_ms())
        .bind(mid.0)
        .bind(cid.0)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let msg = db::message(&state.db, mid, user).await?;
    state.hub.to_guild(guild, &ServerEvent::MessageUpdate(msg.clone()));
    Ok(Json(msg))
}

pub async fn delete(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid)): Path<(Id, Id)>,
) -> AppResult<()> {
    let guild = channel_access(&state, cid, user).await?;
    let owner = db::guild(&state.db, guild).await?.owner_id;
    let r = sqlx::query("DELETE FROM messages WHERE id = ? AND channel_id = ? AND (author_id = ? OR ? = ?)")
        .bind(mid.0)
        .bind(cid.0)
        .bind(user.0)
        .bind(owner.0)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.hub.to_guild(guild, &ServerEvent::MessageDelete(MessageRef { id: mid, channel_id: cid }));
    Ok(())
}

fn valid_emoji(e: &str) -> bool {
    // Either `e:<emote id>` or a short unicode sequence.
    if let Some(id) = e.strip_prefix("e:") {
        return id.parse::<i64>().is_ok();
    }
    !e.is_empty() && e.chars().count() <= 16 && !e.chars().any(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
}

pub async fn react(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid, emoji)): Path<(Id, Id, String)>,
) -> AppResult<()> {
    let guild = channel_access(&state, cid, user).await?;
    if !valid_emoji(&emoji) {
        return Err(bad("invalid emoji"));
    }
    let r = sqlx::query(
        "INSERT OR IGNORE INTO reactions (message_id, emoji, user_id, created_at)
         SELECT id, ?, ?, ? FROM messages WHERE id = ? AND channel_id = ?",
    )
    .bind(&emoji)
    .bind(user.0)
    .bind(db::now_ms())
    .bind(mid.0)
    .bind(cid.0)
    .execute(&state.db)
    .await?;
    if r.rows_affected() > 0 {
        let ev = ReactionEvent { channel_id: cid, message_id: mid, user_id: user, emoji };
        state.hub.to_guild(guild, &ServerEvent::ReactionAdd(ev));
    }
    Ok(())
}

pub async fn unreact(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, mid, emoji)): Path<(Id, Id, String)>,
) -> AppResult<()> {
    let guild = channel_access(&state, cid, user).await?;
    let r = sqlx::query("DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?")
        .bind(mid.0)
        .bind(&emoji)
        .bind(user.0)
        .execute(&state.db)
        .await?;
    if r.rows_affected() > 0 {
        let ev = ReactionEvent { channel_id: cid, message_id: mid, user_id: user, emoji };
        state.hub.to_guild(guild, &ServerEvent::ReactionRemove(ev));
    }
    Ok(())
}
