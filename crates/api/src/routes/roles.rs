//! Guild roles: create, edit, reorder, delete, and give them to people. Managing a role
//! takes MANAGE_ROLES and a higher role than it; nobody can grant a permission they lack.

use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{RoleRef, ServerEvent};
use proto::models::{Member, Role};
use proto::perms::{self, Permissions};
use serde::Deserialize;

use super::require_perm;
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::perms::GuildPerms;
use crate::state::AppState;

const MAX_ROLES: usize = 250;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoleBody {
    name: Option<String>,
    /// Absent leaves it; `null` clears it.
    #[serde(default, deserialize_with = "present")]
    color: Option<Option<u32>>,
    permissions: Option<Permissions>,
    hoist: Option<bool>,
    mentionable: Option<bool>,
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

fn check_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("role names must be 1-100 characters"));
    }
    Ok(name.to_string())
}

/// New permission bits must be ones the actor has (keeping bits the role already had is fine).
fn check_grant(gp: &GuildPerms, actor: Id, old: Permissions, new: Permissions) -> AppResult<Permissions> {
    let new = new & perms::ALL;
    if new & !old & !gp.base(actor) != 0 {
        return Err(bad("you can't grant permissions you don't have"));
    }
    Ok(new)
}

/// Sends what changed between `before` and now (positions shift on create, delete and reorder).
async fn broadcast(state: &AppState, gid: Id, before: &[Role]) -> AppResult<Vec<Role>> {
    state.perms.invalidate(gid);
    let after = db::roles(&state.db, gid).await?;
    for r in &after {
        match before.iter().find(|b| b.id == r.id) {
            None => state.hub.to_guild(gid, &ServerEvent::RoleCreate(r.clone())),
            Some(b) if b != r => state.hub.to_guild(gid, &ServerEvent::RoleUpdate(r.clone())),
            Some(_) => {}
        }
    }
    for b in before.iter().filter(|b| !after.iter().any(|r| r.id == b.id)) {
        state.hub.to_guild(gid, &ServerEvent::RoleDelete(RoleRef { id: b.id, guild_id: gid }));
    }
    Ok(after)
}

pub async fn create(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, Json(body): Json<RoleBody>) -> AppResult<Json<Role>> {
    let gp = require_perm(&state, gid, user, perms::MANAGE_ROLES).await?;
    let before = db::roles(&state.db, gid).await?;
    if before.len() >= MAX_ROLES {
        return Err(bad(format!("a server can have at most {MAX_ROLES} roles")));
    }
    let name = check_name(body.name.as_deref().unwrap_or("new role"))?;
    let permissions = check_grant(&gp, user, 0, body.permissions.unwrap_or(0))?;
    let id = state.ids.next();
    // New roles go at the bottom, just above @everyone.
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE roles SET position = position + 1 WHERE guild_id = $1 AND position >= 1").bind(gid.0).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist, mentionable) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)")
        .bind(id.0)
        .bind(gid.0)
        .bind(&name)
        .bind(body.color.flatten().map(|c| (c & 0xFF_FFFF) as i64))
        .bind(permissions as i64)
        .bind(body.hoist.unwrap_or(false))
        .bind(body.mentionable.unwrap_or(false))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let after = broadcast(&state, gid, &before).await?;
    after.into_iter().find(|r| r.id == id).map(Json).ok_or(AppError::NotFound)
}

pub async fn update(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((gid, rid)): Path<(Id, Id)>,
    Json(body): Json<RoleBody>,
) -> AppResult<Json<Role>> {
    let gp = require_perm(&state, gid, user, perms::MANAGE_ROLES).await?;
    let before = db::roles(&state.db, gid).await?;
    let role = before.iter().find(|r| r.id == rid).ok_or(AppError::NotFound)?;
    let everyone = rid == gid;
    // @everyone sits at 0, below everyone, so anyone with MANAGE_ROLES may edit it.
    if !everyone && !gp.can_manage_role(user, role.position) {
        return Err(bad("you can only edit roles below your highest role"));
    }
    let name = match body.name {
        Some(_) if everyone => return Err(bad("@everyone can't be renamed")),
        Some(n) => check_name(&n)?,
        None => role.name.clone(),
    };
    let permissions = match body.permissions {
        Some(p) => check_grant(&gp, user, role.permissions, p)?,
        None => role.permissions,
    };
    let color = match body.color {
        Some(c) => c.map(|c| c & 0xFF_FFFF),
        None => role.color,
    };
    sqlx::query("UPDATE roles SET name = $1, color = $2, permissions = $3, hoist = $4, mentionable = $5 WHERE id = $6")
        .bind(&name)
        .bind(color.map(|c| c as i64))
        .bind(permissions as i64)
        .bind(!everyone && body.hoist.unwrap_or(role.hoist))
        .bind(body.mentionable.unwrap_or(role.mentionable))
        .bind(rid.0)
        .execute(&state.db)
        .await?;
    let after = broadcast(&state, gid, &before).await?;
    if permissions != role.permissions {
        state.resync_visibility(gid, &gp).await?;
    }
    after.into_iter().find(|r| r.id == rid).map(Json).ok_or(AppError::NotFound)
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path((gid, rid)): Path<(Id, Id)>) -> AppResult<()> {
    let gp = require_perm(&state, gid, user, perms::MANAGE_ROLES).await?;
    if rid == gid {
        return Err(bad("@everyone can't be deleted"));
    }
    let before = db::roles(&state.db, gid).await?;
    let role = before.iter().find(|r| r.id == rid).ok_or(AppError::NotFound)?;
    if !gp.can_manage_role(user, role.position) {
        return Err(bad("you can only delete roles below your highest role"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM roles WHERE id = $1").bind(rid.0).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channel_overwrites WHERE target_kind = 'role' AND target_id = $1").bind(rid.0).execute(&mut *tx).await?;
    sqlx::query("UPDATE roles SET position = position - 1 WHERE guild_id = $1 AND position > $2")
        .bind(gid.0)
        .bind(role.position)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    broadcast(&state, gid, &before).await?;
    state.resync_visibility(gid, &gp).await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct Order {
    /// Every role but @everyone, lowest first.
    ids: Vec<Id>,
}

pub async fn reorder(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, Json(body): Json<Order>) -> AppResult<Json<Vec<Role>>> {
    let gp = require_perm(&state, gid, user, perms::MANAGE_ROLES).await?;
    let before = db::roles(&state.db, gid).await?;
    let mut current: Vec<Id> = before.iter().filter(|r| r.id != gid).map(|r| r.id).collect();
    let mut wanted = body.ids.clone();
    current.sort_unstable();
    wanted.sort_unstable();
    if current != wanted {
        return Err(bad("list every role except @everyone, once each"));
    }
    let top = gp.top(user);
    let owner = user == gp.owner;
    let mut tx = state.db.begin().await?;
    for (i, id) in body.ids.iter().enumerate() {
        let new = i as i32 + 1;
        let old = before.iter().find(|r| r.id == *id).map_or(0, |r| r.position);
        if old == new {
            continue;
        }
        // Roles at or above your own stay where they are.
        if !owner && (old >= top || new >= top) {
            return Err(bad("you can only move roles below your highest role"));
        }
        sqlx::query("UPDATE roles SET position = $1 WHERE id = $2").bind(new).bind(id.0).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(broadcast(&state, gid, &before).await?))
}

async fn set_member_role(state: &AppState, actor: Id, gid: Id, target: Id, rid: Id, on: bool) -> AppResult<Json<Member>> {
    let gp = require_perm(state, gid, actor, perms::MANAGE_ROLES).await?;
    if rid == gid {
        return Err(bad("everyone has @everyone"));
    }
    let role = gp.roles.get(&rid).ok_or(AppError::NotFound)?;
    if !gp.can_manage_role(actor, role.position) {
        return Err(bad("you can only give out roles below your highest role"));
    }
    let r = if on {
        sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) SELECT guild_id, user_id, $1 FROM members WHERE guild_id = $2 AND user_id = $3 ON CONFLICT DO NOTHING")
    } else {
        sqlx::query("DELETE FROM member_roles WHERE role_id = $1 AND guild_id = $2 AND user_id = $3")
    }
    .bind(rid.0)
    .bind(gid.0)
    .bind(target.0)
    .execute(&state.db)
    .await?;
    let member = db::member(&state.db, gid, target).await?;
    if r.rows_affected() > 0 {
        state.resync_visibility(gid, &gp).await?;
        state.hub.to_guild(gid, &proto::gateway::ServerEvent::MemberUpdate(member.clone()));
    }
    Ok(Json(member))
}

pub async fn add_member_role(State(state): State<AppState>, Auth(user): Auth, Path((gid, target, rid)): Path<(Id, Id, Id)>) -> AppResult<Json<Member>> {
    set_member_role(&state, user, gid, target, rid, true).await
}

pub async fn remove_member_role(State(state): State<AppState>, Auth(user): Auth, Path((gid, target, rid)): Path<(Id, Id, Id)>) -> AppResult<Json<Member>> {
    set_member_role(&state, user, gid, target, rid, false).await
}
