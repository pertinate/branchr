//! branchr's own staff and network-wide bans. Admins manage the staff list (the first one is
//! added with `branchr-id staff add <handle> admin`); admins and moderators ban accounts by
//! handle. A banned account is signed out, can't sign in again, and can't log in to any hub
//! with branchr (hubs keep their own bans too).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::AppState;
use crate::error::{Error, Result, bad};
use crate::oauth::authed;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Moderator,
    Admin,
}

impl Role {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(Role::Admin),
            "moderator" => Some(Role::Moderator),
            _ => None,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Moderator => "moderator",
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Who {
    pub id: Uuid,
    pub handle: String,
    pub display_name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Staff {
    pub account: Who,
    pub role: Role,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ban {
    pub account: Who,
    pub reason: String,
    pub banned_by: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub role: Option<Role>,
}

/// Loads the banned accounts into memory (checked on every request).
pub async fn load_bans(s: &AppState) -> anyhow::Result<()> {
    let rows: Vec<(Uuid,)> = sqlx::query_as("SELECT account_id FROM network_bans").fetch_all(&s.db).await?;
    for (id,) in rows {
        s.banned.insert(id);
    }
    Ok(())
}

pub async fn role_of(db: &PgPool, account: Uuid) -> Result<Option<Role>> {
    let r: Option<(String,)> = sqlx::query_as("SELECT role FROM network_staff WHERE account_id = $1").bind(account).fetch_optional(db).await?;
    Ok(r.and_then(|(r,)| Role::parse(&r)))
}

async fn require(s: &AppState, headers: &HeaderMap, min: Role) -> Result<(Uuid, Role)> {
    let me = authed(s, headers).await?;
    match role_of(&s.db, me).await? {
        Some(r) if r >= min => Ok((me, r)),
        _ => Err(Error::Forbidden("branchr staff only".into())),
    }
}

async fn by_handle(db: &PgPool, handle: &str) -> Result<Who> {
    let handle = handle.trim().trim_start_matches('@').to_lowercase();
    let r: Option<(Uuid, String, String)> = sqlx::query_as("SELECT id, handle, display_name FROM accounts WHERE handle = $1").bind(&handle).fetch_optional(db).await?;
    let (id, handle, display_name) = r.ok_or_else(|| bad("invalid_request", format!("no branchr account @{handle}")))?;
    Ok(Who { id, handle, display_name })
}

pub async fn me(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Me>> {
    let me = authed(&s, &headers).await?;
    Ok(Json(Me { role: role_of(&s.db, me).await? }))
}

pub async fn staff(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<Staff>>> {
    require(&s, &headers, Role::Moderator).await?;
    let rows: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT a.id, a.handle, a.display_name, n.role FROM network_staff n JOIN accounts a ON a.id = n.account_id ORDER BY n.role, a.handle",
    )
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .filter_map(|(id, handle, display_name, role)| Some(Staff { account: Who { id, handle, display_name }, role: Role::parse(&role)? }))
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct SetStaff {
    role: String,
}

pub async fn set_staff(State(s): State<AppState>, headers: HeaderMap, Path(handle): Path<String>, Json(body): Json<SetStaff>) -> Result<StatusCode> {
    let (me, _) = require(&s, &headers, Role::Admin).await?;
    let who = by_handle(&s.db, &handle).await?;
    let role = Role::parse(&body.role).ok_or_else(|| bad("invalid_request", "role is admin or moderator"))?;
    if who.id == me {
        return Err(bad("invalid_request", "another admin has to change your role"));
    }
    if s.banned.contains(&who.id) {
        return Err(bad("invalid_request", "they're banned; unban them first"));
    }
    sqlx::query("INSERT INTO network_staff (account_id, role) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET role = $2")
        .bind(who.id)
        .bind(role.as_str())
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_staff(State(s): State<AppState>, headers: HeaderMap, Path(handle): Path<String>) -> Result<StatusCode> {
    let (me, _) = require(&s, &headers, Role::Admin).await?;
    let who = by_handle(&s.db, &handle).await?;
    if who.id == me {
        return Err(bad("invalid_request", "another admin has to remove you"));
    }
    sqlx::query("DELETE FROM network_staff WHERE account_id = $1").bind(who.id).execute(&s.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn bans(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<Ban>>> {
    require(&s, &headers, Role::Moderator).await?;
    let rows: Vec<(Uuid, String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT a.id, a.handle, a.display_name, b.reason, by_.handle, (EXTRACT(EPOCH FROM b.created_at) * 1000)::BIGINT
         FROM network_bans b JOIN accounts a ON a.id = b.account_id LEFT JOIN accounts by_ ON by_.id = b.banned_by
         ORDER BY b.created_at DESC LIMIT 500",
    )
    .fetch_all(&s.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, handle, display_name, reason, banned_by, created_at)| Ban { account: Who { id, handle, display_name }, reason, banned_by, created_at })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct BanBody {
    reason: String,
}

pub async fn ban(State(s): State<AppState>, headers: HeaderMap, Path(handle): Path<String>, Json(body): Json<BanBody>) -> Result<StatusCode> {
    let (me, _) = require(&s, &headers, Role::Moderator).await?;
    let who = by_handle(&s.db, &handle).await?;
    let reason = body.reason.trim();
    if reason.is_empty() || reason.chars().count() > 500 {
        return Err(bad("invalid_request", "give a reason (up to 500 characters)"));
    }
    if who.id == me || role_of(&s.db, who.id).await?.is_some() {
        return Err(bad("invalid_request", "staff can't be banned; take them off the staff list first"));
    }
    sqlx::query("INSERT INTO network_bans (account_id, reason, banned_by) VALUES ($1, $2, $3) ON CONFLICT (account_id) DO UPDATE SET reason = $2, banned_by = $3")
        .bind(who.id)
        .bind(reason)
        .bind(me)
        .execute(&s.db)
        .await?;
    // Signed out everywhere: no refreshing, no live connections, no requests from here on.
    sqlx::query("DELETE FROM refresh_tokens WHERE account_id = $1").bind(who.id).execute(&s.db).await?;
    s.banned.insert(who.id);
    s.hub.kick(who.id);
    tracing::info!("network ban: @{} by {me}", who.handle);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unban(State(s): State<AppState>, headers: HeaderMap, Path(handle): Path<String>) -> Result<StatusCode> {
    require(&s, &headers, Role::Moderator).await?;
    let who = by_handle(&s.db, &handle).await?;
    sqlx::query("DELETE FROM network_bans WHERE account_id = $1").bind(who.id).execute(&s.db).await?;
    s.banned.remove(&who.id);
    Ok(StatusCode::NO_CONTENT)
}

/// `branchr-id staff add <handle> <admin|moderator>` / `staff remove <handle>`: the first admin
/// (and a way back in), from the server's own command line.
pub async fn cli(db: &PgPool, args: &[String]) -> anyhow::Result<()> {
    match args {
        [cmd, handle, role] if cmd == "add" => {
            let role = Role::parse(role).ok_or_else(|| anyhow::anyhow!("role is admin or moderator"))?;
            let who = by_handle(db, handle).await.map_err(|e| anyhow::anyhow!("{e}"))?;
            sqlx::query("INSERT INTO network_staff (account_id, role) VALUES ($1, $2) ON CONFLICT (account_id) DO UPDATE SET role = $2")
                .bind(who.id)
                .bind(role.as_str())
                .execute(db)
                .await?;
            println!("@{} is now a branchr {}", who.handle, role.as_str());
        }
        [cmd, handle] if cmd == "remove" => {
            let who = by_handle(db, handle).await.map_err(|e| anyhow::anyhow!("{e}"))?;
            sqlx::query("DELETE FROM network_staff WHERE account_id = $1").bind(who.id).execute(db).await?;
            println!("@{} is no longer branchr staff", who.handle);
        }
        _ => anyhow::bail!("usage: branchr-id staff add <handle> <admin|moderator> | staff remove <handle>"),
    }
    Ok(())
}
