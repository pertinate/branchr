//! Managing the host itself: the branchr account that claimed it (the owner), and the
//! admins and moderators it appoints. Overview and settings, people (bans and staff), and
//! every server (guild) on it.

use std::sync::atomic::Ordering;

use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::{GuildRef, ServerEvent};
use proto::models::{HostGuild, HostOverview, HostRole, HostUser};
use serde::Deserialize;

use crate::auth::Auth;
use crate::config::AuthMode;
use crate::db::{self, DbBool};
use crate::error::{AppError, AppResult, bad};
use crate::gateway::evict_user;
use crate::state::AppState;

const PAGE: i64 = 50;

/// The host's owner: the local user tied to the branchr account that claimed it.
async fn owner_id(state: &AppState) -> AppResult<Option<Id>> {
    let Some(owner) = state.federation.as_ref().and_then(|f| f.identity()).and_then(|i| i.owner) else { return Ok(None) };
    let row: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE global_id = $1").bind(owner).fetch_optional(&state.db).await?;
    Ok(row.map(|(id,)| Id(id)))
}

/// `user`'s role on this host, if they have one.
pub async fn host_role(state: &AppState, user: Id) -> AppResult<Option<HostRole>> {
    if owner_id(state).await? == Some(user) {
        return Ok(Some(HostRole::Owner));
    }
    let row: Option<(String,)> = sqlx::query_as("SELECT role FROM instance_staff WHERE user_id = $1").bind(user.0).fetch_optional(&state.db).await?;
    Ok(row.and_then(|(r,)| HostRole::parse(&r)))
}

/// Requires at least `min`; returns the role they have.
async fn require_role(state: &AppState, user: Id, min: HostRole) -> AppResult<HostRole> {
    match host_role(state, user).await? {
        Some(r) if r >= min => Ok(r),
        _ => Err(AppError::Forbidden),
    }
}

pub async fn overview(State(state): State<AppState>, Auth(user): Auth) -> AppResult<Json<HostOverview>> {
    let my_role = require_role(&state, user, HostRole::Moderator).await?;
    let (users, banned, guilds, messages, bytes): (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM instance_bans), (SELECT count(*) FROM guilds),
                (SELECT count(*) FROM messages), (SELECT CAST(coalesce(sum(size), 0) AS BIGINT) FROM attachments)",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(HostOverview {
        name: state.config.instance_name.clone(),
        auth_mode: match state.config.auth_mode {
            AuthMode::Local => "local",
            AuthMode::Federated => "federated",
            AuthMode::Both => "both",
        }
        .into(),
        open_registration: state.open_registration.load(Ordering::Relaxed),
        users: users as u32,
        banned: banned as u32,
        guilds: guilds as u32,
        messages: messages as u64,
        attachment_bytes: bytes as u64,
        my_role,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSettings {
    open_registration: Option<bool>,
}

pub async fn settings(State(state): State<AppState>, Auth(user): Auth, Json(body): Json<PatchSettings>) -> AppResult<Json<HostOverview>> {
    require_role(&state, user, HostRole::Admin).await?;
    if let Some(open) = body.open_registration {
        sqlx::query("INSERT INTO instance_settings (key, value) VALUES ('open_registration', $1) ON CONFLICT (key) DO UPDATE SET value = $1")
            .bind(if open { "true" } else { "false" })
            .execute(&state.db)
            .await?;
        state.open_registration.store(open, Ordering::Relaxed);
    }
    overview(State(state), Auth(user)).await
}

/// Applies settings saved by the owner over the environment's defaults (at startup).
pub async fn load_settings(state: &AppState) -> anyhow::Result<()> {
    let open: Option<(String,)> = sqlx::query_as("SELECT value FROM instance_settings WHERE key = 'open_registration'").fetch_optional(&state.db).await?;
    if let Some((v,)) = open {
        state.open_registration.store(v == "true", Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct UserQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    banned: bool,
    #[serde(default)]
    offset: i64,
}

#[derive(sqlx::FromRow)]
struct HostUserRow {
    id: i64,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    created_at: i64,
    global_id: Option<String>,
    guilds: i64,
    banned: DbBool,
    reason: Option<String>,
}

pub async fn users(State(state): State<AppState>, Auth(user): Auth, Query(q): Query<UserQuery>) -> AppResult<Json<Vec<HostUser>>> {
    require_role(&state, user, HostRole::Moderator).await?;
    let owner = owner_id(&state).await?;
    let staff: Vec<(i64, String)> = sqlx::query_as("SELECT user_id, role FROM instance_staff").fetch_all(&state.db).await?;
    let pattern = format!("%{}%", q.q.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<HostUserRow> = sqlx::query_as(
        "SELECT u.id, u.username, u.display_name, u.avatar_url, u.created_at, u.global_id,
                (SELECT count(*) FROM members m WHERE m.user_id = u.id) AS guilds,
                b.user_id IS NOT NULL AS banned, b.reason
         FROM users u LEFT JOIN instance_bans b ON b.user_id = u.id
         WHERE (lower(u.username) LIKE lower($1) ESCAPE '\\' OR lower(u.display_name) LIKE lower($1) ESCAPE '\\') AND (NOT $2 OR b.user_id IS NOT NULL)
         ORDER BY u.id DESC LIMIT $3 OFFSET $4",
    )
    .bind(&pattern)
    .bind(q.banned)
    .bind(PAGE)
    .bind(q.offset.max(0))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| HostUser {
                owner: owner == Some(Id(r.id)),
                role: if owner == Some(Id(r.id)) {
                    Some(HostRole::Owner)
                } else {
                    staff.iter().find(|(u, _)| *u == r.id).and_then(|(_, role)| HostRole::parse(role))
                },
                user: proto::models::User { id: Id(r.id), username: r.username, display_name: r.display_name, avatar_url: r.avatar_url, global_id: r.global_id.clone() },
                created_at: r.created_at,
                linked: r.global_id.is_some(),
                guilds: r.guilds as u32,
                banned: r.banned.0,
                ban_reason: r.reason,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct Ban {
    #[serde(default)]
    reason: Option<String>,
}

/// Bans someone from the whole host: their sessions end and they can't log back in.
pub async fn ban(State(state): State<AppState>, Auth(user): Auth, Path(target): Path<Id>, Json(body): Json<Ban>) -> AppResult<()> {
    let mine = require_role(&state, user, HostRole::Moderator).await?;
    // Staff can only act on people below them.
    if host_role(&state, target).await?.is_some_and(|theirs| theirs >= mine) {
        return Err(bad("you can't ban someone whose host role is the same as or above yours"));
    }
    if target == user {
        return Err(bad("you can't ban yourself"));
    }
    let reason = body.reason.map(|r| r.trim().chars().take(500).collect::<String>()).filter(|r| !r.is_empty());
    let r = sqlx::query("INSERT INTO instance_bans (user_id, reason, banned_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET reason = $2")
        .bind(target.0)
        .bind(&reason)
        .bind(db::now_ms())
        .execute(&state.db)
        .await;
    match r {
        Err(sqlx::Error::Database(e)) if e.is_foreign_key_violation() => return Err(AppError::NotFound),
        r => {
            r?;
        }
    }
    // Log them out everywhere on this host.
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(target.0).execute(&state.db).await?;
    state.sessions.retain(|_, u| *u != target);
    evict_user(&state, target);
    tracing::info!("host owner banned user {}", target.0);
    Ok(())
}

pub async fn unban(State(state): State<AppState>, Auth(user): Auth, Path(target): Path<Id>) -> AppResult<()> {
    require_role(&state, user, HostRole::Moderator).await?;
    sqlx::query("DELETE FROM instance_bans WHERE user_id = $1").bind(target.0).execute(&state.db).await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct GuildQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: i64,
}

#[derive(sqlx::FromRow)]
struct HostGuildRow {
    gid: i64,
    name: String,
    icon_url: Option<String>,
    owner_id: i64,
    banner_url: Option<String>,
    description: Option<String>,
    system_channel_id: Option<i64>,
    vanity_code: Option<String>,
    members: i64,
    channels: i64,
}

pub async fn guilds(State(state): State<AppState>, Auth(user): Auth, Query(q): Query<GuildQuery>) -> AppResult<Json<Vec<HostGuild>>> {
    require_role(&state, user, HostRole::Admin).await?;
    let pattern = format!("%{}%", q.q.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<HostGuildRow> = sqlx::query_as(
        "SELECT g.id AS gid, g.name, g.icon_url, g.owner_id, g.banner_url, g.description, g.system_channel_id, g.vanity_code,
                (SELECT count(*) FROM members m WHERE m.guild_id = g.id) AS members,
                (SELECT count(*) FROM channels c WHERE c.guild_id = g.id) AS channels
         FROM guilds g WHERE lower(g.name) LIKE lower($1) ESCAPE '\\' ORDER BY g.id DESC LIMIT $2 OFFSET $3",
    )
    .bind(&pattern)
    .bind(PAGE)
    .bind(q.offset.max(0))
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(HostGuild {
            owner: db::user(&state.db, Id(r.owner_id)).await?,
            guild: proto::models::Guild {
                id: Id(r.gid),
                name: r.name,
                icon_url: r.icon_url,
                owner_id: Id(r.owner_id),
                banner_url: r.banner_url,
                description: r.description,
                system_channel_id: r.system_channel_id.map(Id),
                vanity_code: r.vanity_code,
            },
            members: r.members as u32,
            channels: r.channels as u32,
        });
    }
    Ok(Json(out))
}

/// Deletes any server on the host (abuse, spam).
pub async fn delete_guild(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<()> {
    require_role(&state, user, HostRole::Admin).await?;
    let r = sqlx::query("DELETE FROM guilds WHERE id = $1").bind(gid.0).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.hub.to_guild(gid, &ServerEvent::GuildDelete(GuildRef { id: gid }));
    state.hub.drop_guild(gid);
    state.channel_guild.retain(|_, g| *g != gid);
    tracing::info!("host owner deleted guild {}", gid.0);
    Ok(())
}

#[derive(Deserialize)]
pub struct SetStaff {
    /// `admin`, `moderator`, or null to take the role away.
    role: Option<String>,
}

/// The owner appoints (or removes) admins and moderators.
pub async fn set_staff(State(state): State<AppState>, Auth(user): Auth, Path(target): Path<Id>, Json(body): Json<SetStaff>) -> AppResult<Json<HostUser>> {
    require_role(&state, user, HostRole::Owner).await?;
    if target == user {
        return Err(bad("you're the owner"));
    }
    db::user(&state.db, target).await?;
    match body.role.as_deref() {
        None => {
            sqlx::query("DELETE FROM instance_staff WHERE user_id = $1").bind(target.0).execute(&state.db).await?;
        }
        Some(r) => {
            let role = HostRole::parse(r).ok_or_else(|| bad("role is admin or moderator"))?;
            sqlx::query("INSERT INTO instance_staff (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role")
                .bind(target.0)
                .bind(role.as_str())
                .execute(&state.db)
                .await?;
        }
    }
    tracing::info!("host owner set {}'s role to {:?}", target.0, body.role);
    let q = UserQuery { q: db::user(&state.db, target).await?.username, banned: false, offset: 0 };
    let list = users(State(state), Auth(user), Query(q)).await?.0;
    list.into_iter().find(|u| u.user.id == target).map(Json).ok_or(AppError::NotFound)
}
