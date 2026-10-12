//! Webhooks: a URL with a secret in it that posts into one channel, for bots, CI and alerts.
//! Each webhook is also a bot user, so its messages have an author like any other.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use proto::Id;
use proto::gateway::ServerEvent;
use proto::models::{AuditAction, ChannelKind, Message, MessageKind, Webhook};
use proto::perms;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{channel_perm, require_perm};
use crate::audit::{self, Entry};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

const MAX_PER_GUILD: i64 = 15;
const MAX_LEN: usize = 2000;

#[derive(sqlx::FromRow)]
struct Row {
    id: i64,
    guild_id: i64,
    channel_id: i64,
    name: String,
    creator_id: i64,
    created_at: i64,
}

impl From<Row> for Webhook {
    fn from(r: Row) -> Self {
        Webhook { id: Id(r.id), guild_id: Id(r.guild_id), channel_id: Id(r.channel_id), name: r.name, creator_id: Id(r.creator_id), created_at: r.created_at, token: None }
    }
}

const COLS: &str = "id, guild_id, channel_id, name, creator_id, created_at";

fn new_token() -> String {
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    raw.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(bad("a webhook name is 1-80 characters"));
    }
    Ok(name.to_string())
}

async fn webhook(state: &AppState, wid: Id) -> AppResult<Webhook> {
    let r: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLS} FROM webhooks WHERE id = $1"))).bind(wid.0).fetch_optional(&state.db).await?;
    r.map(Into::into).ok_or(AppError::NotFound)
}

pub async fn list(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<Json<Vec<Webhook>>> {
    require_perm(&state, gid, user, perms::MANAGE_WEBHOOKS).await?;
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLS} FROM webhooks WHERE guild_id = $1 ORDER BY id"))).bind(gid.0).fetch_all(&state.db).await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
pub struct CreateWebhook {
    name: String,
}

pub async fn create(State(state): State<AppState>, Auth(user): Auth, Path(cid): Path<Id>, Json(body): Json<CreateWebhook>) -> AppResult<Json<Webhook>> {
    let (gid, _) = channel_perm(&state, cid, user, perms::MANAGE_WEBHOOKS).await?;
    if db::channel(&state.db, cid).await?.kind != ChannelKind::Text {
        return Err(bad("webhooks post into text channels"));
    }
    let name = clean_name(&body.name)?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM webhooks WHERE guild_id = $1").bind(gid.0).fetch_one(&state.db).await?;
    if count >= MAX_PER_GUILD {
        return Err(bad(format!("a server can have up to {MAX_PER_GUILD} webhooks")));
    }
    let id = state.ids.next();
    let token = new_token();
    let now = db::now_ms();
    let mut tx = state.db.begin().await?;
    // No password can match "!", so nobody can log in as it.
    sqlx::query("INSERT INTO users (id, username, display_name, password_hash, created_at, bot) VALUES ($1, $2, $3, '!', $4, $5)")
        .bind(id.0)
        .bind(format!("webhook-{id}"))
        .bind(&name)
        .bind(now)
        .bind(true)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO webhooks (id, guild_id, channel_id, name, token_hash, creator_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(id.0)
        .bind(gid.0)
        .bind(cid.0)
        .bind(&name)
        .bind(hash(&token))
        .bind(user.0)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    audit::log(&state, gid, user, Entry::new(AuditAction::WebhookCreate, Some(id), name)).await;
    let mut w = webhook(&state, id).await?;
    w.token = Some(token);
    Ok(Json(w))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchWebhook {
    name: Option<String>,
    channel_id: Option<Id>,
    /// A new secret (the old URL stops working).
    #[serde(default)]
    reset_token: bool,
}

pub async fn patch(State(state): State<AppState>, Auth(user): Auth, Path(wid): Path<Id>, Json(body): Json<PatchWebhook>) -> AppResult<Json<Webhook>> {
    let before = webhook(&state, wid).await?;
    require_perm(&state, before.guild_id, user, perms::MANAGE_WEBHOOKS).await?;
    if let Some(name) = &body.name {
        let name = clean_name(name)?;
        sqlx::query("UPDATE webhooks SET name = $1 WHERE id = $2").bind(&name).bind(wid.0).execute(&state.db).await?;
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2").bind(&name).bind(wid.0).execute(&state.db).await?;
    }
    if let Some(cid) = body.channel_id {
        let (gid, _) = channel_perm(&state, cid, user, perms::MANAGE_WEBHOOKS).await?;
        if gid != before.guild_id || db::channel(&state.db, cid).await?.kind != ChannelKind::Text {
            return Err(bad("pick a text channel in this server"));
        }
        sqlx::query("UPDATE webhooks SET channel_id = $1 WHERE id = $2").bind(cid.0).bind(wid.0).execute(&state.db).await?;
    }
    let token = body.reset_token.then(new_token);
    if let Some(t) = &token {
        sqlx::query("UPDATE webhooks SET token_hash = $1 WHERE id = $2").bind(hash(t)).bind(wid.0).execute(&state.db).await?;
    }
    let mut w = webhook(&state, wid).await?;
    let entry = Entry::new(AuditAction::WebhookUpdate, Some(wid), w.name.clone())
        .change("name", Some(&before.name), Some(&w.name))
        .change("channel", Some(before.channel_id.to_string()), Some(w.channel_id.to_string()))
        .change("url", None, token.as_ref().map(|_| "reset"));
    if !entry.changes.is_empty() {
        audit::log(&state, w.guild_id, user, entry).await;
    }
    w.token = token;
    Ok(Json(w))
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path(wid): Path<Id>) -> AppResult<StatusCode> {
    let w = webhook(&state, wid).await?;
    require_perm(&state, w.guild_id, user, perms::MANAGE_WEBHOOKS).await?;
    // Its user stays: its messages still need an author.
    sqlx::query("DELETE FROM webhooks WHERE id = $1").bind(wid.0).execute(&state.db).await?;
    audit::log(&state, w.guild_id, user, Entry::new(AuditAction::WebhookDelete, Some(wid), w.name)).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Execute {
    #[serde(default)]
    content: String,
    /// This post's name and avatar, instead of the webhook's (Discord's field names, so
    /// existing tools work).
    username: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
pub struct ExecuteQuery {
    /// Reply with the message instead of 204.
    #[serde(default)]
    wait: bool,
}

/// `POST /api/webhooks/{id}/{token}`: no account needed, the secret is the key.
pub async fn execute(State(state): State<AppState>, Path((wid, token)): Path<(Id, String)>, Query(q): Query<ExecuteQuery>, Json(body): Json<Execute>) -> AppResult<Response> {
    let found: Option<(i64, i64, String)> = sqlx::query_as("SELECT guild_id, channel_id, token_hash FROM webhooks WHERE id = $1").bind(wid.0).fetch_optional(&state.db).await?;
    let Some((gid, cid, _)) = found.filter(|(_, _, h)| *h == hash(&token)) else {
        return Err(AppError::NotFound);
    };
    let (gid, cid) = (Id(gid), Id(cid));
    // Discord's limit: five posts every two seconds per webhook.
    if !state.webhook_limiter.check(wid) {
        return Err(AppError::TooManyRequests);
    }
    let content = body.content.trim().to_string();
    if content.is_empty() || content.chars().count() > MAX_LEN {
        return Err(bad(format!("content must be 1-{MAX_LEN} characters")));
    }
    let name = body.username.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(80).collect::<String>());
    let avatar = match (&body.avatar_url, &state.unfurl) {
        // A copy on this server, like link previews (never the original's address).
        (Some(u), Some(unfurl)) => unfurl.copy_avatar(&state, u).await,
        _ => None,
    };
    let id = state.ids.next();
    sqlx::query("INSERT INTO messages (id, channel_id, author_id, content, mention_everyone, author_name, author_avatar) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(id.0)
        .bind(cid.0)
        .bind(wid.0)
        .bind(&content)
        .bind(false)
        .bind(&name)
        .bind(&avatar)
        .execute(&state.db)
        .await?;
    let msg: Message = db::message(&state.db, id, wid).await?;
    debug_assert_eq!(msg.kind, MessageKind::Default);
    state.to_channel(gid, cid, &ServerEvent::MessageCreate(msg.clone())).await;
    crate::unfurl::spawn(state.clone(), gid, cid, id, wid, content, false);
    Ok(if q.wait { Json(msg).into_response() } else { StatusCode::NO_CONTENT.into_response() })
}
