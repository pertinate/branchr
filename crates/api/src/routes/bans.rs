//! Guild bans and the audit log.

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::{MessageRef, ServerEvent};
use proto::models::{AuditAction, AuditEntry, AuditLog, GuildBan};
use proto::perms;
use serde::Deserialize;
use sqlx::AssertSqlSafe;

use super::guilds::remove_member;
use super::require_perm;
use crate::audit::{self, Entry};
use crate::auth::Auth;
use crate::db::{self, DbBool};
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

/// Longest message history a ban can delete (a week, like Discord).
const MAX_DELETE_HOURS: i64 = 7 * 24;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BanBody {
    reason: Option<String>,
    /// Also delete their messages from the last this many hours.
    #[serde(default)]
    delete_message_hours: i64,
}

fn clean_reason(r: Option<String>) -> Option<String> {
    r.map(|r| r.trim().chars().take(512).collect::<String>()).filter(|r| !r.is_empty())
}

pub async fn ban(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((gid, target)): Path<(Id, Id)>,
    Json(body): Json<BanBody>,
) -> AppResult<()> {
    let gp = require_perm(&state, gid, user, perms::BAN_MEMBERS).await?;
    if target == user {
        return Err(bad("you can't ban yourself"));
    }
    if !gp.outranks(user, target) {
        return Err(bad("you can only ban people whose highest role is below yours"));
    }
    if !(0..=MAX_DELETE_HOURS).contains(&body.delete_message_hours) {
        return Err(bad("messages can be deleted from up to the last 7 days"));
    }
    let target_user = db::user(&state.db, target).await?;
    let global: Option<(Option<String>,)> = sqlx::query_as("SELECT global_id FROM users WHERE id = $1").bind(target.0).fetch_optional(&state.db).await?;
    let reason = clean_reason(body.reason);
    sqlx::query(
        "INSERT INTO guild_bans (guild_id, user_id, global_id, reason, banned_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by",
    )
    .bind(gid.0)
    .bind(target.0)
    .bind(global.and_then(|g| g.0))
    .bind(&reason)
    .bind(user.0)
    .bind(db::now_ms())
    .execute(&state.db)
    .await?;
    // Out of the server, if they're in it.
    match remove_member(&state, gid, target).await {
        Ok(()) | Err(AppError::NotFound) => {}
        Err(e) => return Err(e),
    }
    if body.delete_message_hours > 0 {
        delete_recent(&state, gid, target, body.delete_message_hours).await?;
    }
    audit::log(&state, gid, user, Entry::new(AuditAction::MemberBanAdd, Some(target), target_user.username).reason(reason)).await;
    Ok(())
}

/// Deletes `target`'s messages in `gid` from the last `hours` (message ids carry their time).
async fn delete_recent(state: &AppState, gid: Id, target: Id, hours: i64) -> AppResult<()> {
    let since_ms = db::now_ms() - hours * 3600 * 1000;
    let since_id = (since_ms - proto::id::EPOCH_MS as i64).max(0) << 22;
    let gone: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT m.id, m.channel_id FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE c.guild_id = $1 AND m.author_id = $2 AND m.id >= $3",
    )
    .bind(gid.0)
    .bind(target.0)
    .bind(since_id)
    .fetch_all(&state.db)
    .await?;
    if gone.is_empty() {
        return Ok(());
    }
    // Ids are integers we read ourselves, so inlining them is safe.
    for chunk in gone.chunks(500) {
        let ids = chunk.iter().map(|(id, _)| id.to_string()).collect::<Vec<_>>().join(",");
        sqlx::query(AssertSqlSafe(format!("DELETE FROM messages WHERE id IN ({ids})"))).execute(&state.db).await?;
    }
    for (id, cid) in gone {
        state.to_channel(gid, Id(cid), &ServerEvent::MessageDelete(MessageRef { id: Id(id), channel_id: Id(cid) })).await;
    }
    Ok(())
}

pub async fn unban(State(state): State<AppState>, Auth(user): Auth, Path((gid, target)): Path<(Id, Id)>) -> AppResult<()> {
    require_perm(&state, gid, user, perms::BAN_MEMBERS).await?;
    let r = sqlx::query("DELETE FROM guild_bans WHERE guild_id = $1 AND user_id = $2").bind(gid.0).bind(target.0).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let name = db::user(&state.db, target).await.ok().map(|u| u.username);
    audit::log(&state, gid, user, Entry::new(AuditAction::MemberBanRemove, Some(target), name)).await;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct BanRow {
    reason: Option<String>,
    banned_by: Option<i64>,
    created_at: i64,
    #[sqlx(flatten)]
    user: db::UserRow,
}

pub async fn list(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<Json<Vec<GuildBan>>> {
    require_perm(&state, gid, user, perms::BAN_MEMBERS).await?;
    let rows: Vec<BanRow> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT b.reason, b.banned_by, b.created_at, {} FROM guild_bans b JOIN users u ON u.id = b.user_id
         WHERE b.guild_id = $1 ORDER BY b.created_at DESC",
        db::USER_COLS
    )))
    .bind(gid.0)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| GuildBan { user: r.user.into(), reason: r.reason, banned_by: r.banned_by.map(Id), created_at: r.created_at })
            .collect(),
    ))
}

/// Whether `user` (or their branchr account) is banned from `gid`.
pub async fn is_banned(state: &AppState, gid: Id, user: Id) -> AppResult<bool> {
    let r: Option<(DbBool,)> = sqlx::query_as(
        "SELECT true FROM guild_bans b WHERE b.guild_id = $1 AND (b.user_id = $2
           OR (b.global_id IS NOT NULL AND b.global_id = (SELECT global_id FROM users WHERE id = $2)))",
    )
    .bind(gid.0)
    .bind(user.0)
    .fetch_optional(&state.db)
    .await?;
    Ok(r.is_some())
}

#[derive(Deserialize)]
pub struct AuditQuery {
    before: Option<Id>,
    limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct AuditRow {
    id: i64,
    actor_id: i64,
    action: String,
    target_id: Option<i64>,
    target_name: Option<String>,
    changes: Option<String>,
    reason: Option<String>,
}

pub async fn audit_log(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, Query(q): Query<AuditQuery>) -> AppResult<Json<AuditLog>> {
    require_perm(&state, gid, user, perms::VIEW_AUDIT_LOG).await?;
    let rows: Vec<AuditRow> = sqlx::query_as(
        "SELECT id, actor_id, action, target_id, target_name, changes, reason FROM audit_log
         WHERE guild_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
    )
    .bind(gid.0)
    .bind(q.before.map_or(i64::MAX, |b| b.0))
    .bind(q.limit.unwrap_or(50).clamp(1, 100))
    .fetch_all(&state.db)
    .await?;
    let entries: Vec<AuditEntry> = rows
        .into_iter()
        .filter_map(|r| {
            Some(AuditEntry {
                id: Id(r.id),
                actor_id: Id(r.actor_id),
                action: AuditAction::parse(&r.action)?,
                target_id: r.target_id.map(Id),
                target_name: r.target_name,
                changes: r.changes.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default(),
                reason: r.reason,
            })
        })
        .collect();
    // Everyone it names, so people who left still show up.
    let ids: HashSet<i64> = entries.iter().flat_map(|e| std::iter::once(e.actor_id.0).chain(e.target_id.map(|t| t.0))).collect();
    let users = if ids.is_empty() {
        Vec::new()
    } else {
        let list = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        sqlx::query_as::<_, db::UserRow>(AssertSqlSafe(format!("SELECT {} FROM users u WHERE u.id IN ({list})", db::USER_COLS)))
            .fetch_all(&state.db)
            .await?
            .into_iter()
            .map(Into::into)
            .collect()
    };
    Ok(Json(AuditLog { entries, users }))
}
