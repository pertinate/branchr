use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{ChannelRef, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::{channel_perm, require_perm};
use proto::perms::{self, Permissions};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::perms::GuildPerms;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannel {
    name: String,
    kind: ChannelKind,
    parent_id: Option<Id>,
    topic: Option<String>,
}

fn normalize(name: &str, kind: ChannelKind) -> AppResult<String> {
    let name = name.trim();
    let name = if kind == ChannelKind::Text {
        // Text channel names are lowercase-kebab like Discord.
        name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-")
    } else {
        name.to_string()
    };
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("channel name must be 1-100 characters"));
    }
    Ok(name)
}

pub async fn create(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<CreateChannel>,
) -> AppResult<Json<Channel>> {
    require_perm(&state, gid, user, perms::MANAGE_CHANNELS).await?;
    let name = normalize(&body.name, body.kind)?;
    if let Some(p) = body.parent_id {
        let parent = db::channel(&state.db, p).await?;
        if parent.guild_id != gid || parent.kind != ChannelKind::Category || body.kind == ChannelKind::Category {
            return Err(bad("invalid parent"));
        }
    }
    let id = state.ids.next();
    sqlx::query(
        "INSERT INTO channels (id, guild_id, name, kind, parent_id, topic, position)
         VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(position) + 1, 0) FROM channels WHERE guild_id = $2 AND parent_id IS NOT DISTINCT FROM $5))",
    )
    .bind(id.0)
    .bind(gid.0)
    .bind(&name)
    .bind(body.kind.as_str())
    .bind(body.parent_id.map(|p| p.0))
    .bind(&body.topic)
    .execute(&state.db)
    .await?;
    let c = db::channel(&state.db, id).await?;
    state.channel_guild.insert(id, gid);
    state.to_channel(gid, id, &ServerEvent::ChannelCreate(c.clone())).await;
    Ok(Json(c))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchChannel {
    name: Option<String>,
    topic: Option<Option<String>>,
    position: Option<i32>,
}

pub async fn patch(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    Json(body): Json<PatchChannel>,
) -> AppResult<Json<Channel>> {
    let c = db::channel(&state.db, cid).await?;
    require_perm(&state, c.guild_id, user, perms::MANAGE_CHANNELS).await?;
    if let Some(name) = body.name {
        let name = normalize(&name, c.kind)?;
        sqlx::query("UPDATE channels SET name = $1 WHERE id = $2").bind(name).bind(cid.0).execute(&state.db).await?;
    }
    if let Some(topic) = body.topic {
        if topic.as_ref().is_some_and(|t| t.chars().count() > 1024) {
            return Err(bad("topic too long"));
        }
        sqlx::query("UPDATE channels SET topic = $1 WHERE id = $2").bind(topic).bind(cid.0).execute(&state.db).await?;
    }
    if let Some(pos) = body.position {
        sqlx::query("UPDATE channels SET position = $1 WHERE id = $2").bind(pos).bind(cid.0).execute(&state.db).await?;
    }
    let c = db::channel(&state.db, cid).await?;
    state.to_channel(c.guild_id, cid, &ServerEvent::ChannelUpdate(c.clone())).await;
    Ok(Json(c))
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path(cid): Path<Id>) -> AppResult<()> {
    let c = db::channel(&state.db, cid).await?;
    require_perm(&state, c.guild_id, user, perms::MANAGE_CHANNELS).await?;
    let mut tx = state.db.begin().await?;
    // Children of a deleted category become top level.
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = $1").bind(cid.0).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(cid.0).execute(&mut *tx).await?;
    tx.commit().await?;
    if c.kind == ChannelKind::Category {
        for ch in db::channels(&state.db, c.guild_id).await?.into_iter().filter(|ch| ch.parent_id.is_none()) {
            state.to_channel(c.guild_id, ch.id, &ServerEvent::ChannelUpdate(ch)).await;
        }
    }
    // Told to whoever could see it, by the permissions cached from before the delete.
    state.to_channel(c.guild_id, cid, &ServerEvent::ChannelDelete(ChannelRef { id: cid, guild_id: c.guild_id })).await;
    state.channel_guild.remove(&cid);
    state.perms.invalidate(c.guild_id);
    Ok(())
}

#[derive(Deserialize)]
pub struct PutOverwrite {
    kind: OverwriteKind,
    #[serde(default)]
    allow: Permissions,
    #[serde(default)]
    deny: Permissions,
}

/// Sets a role's or member's permissions in one channel. Needs MANAGE_ROLES there, and only
/// bits you have yourself in the channel can be allowed or denied.
pub async fn put_overwrite(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, target)): Path<(Id, Id)>,
    Json(body): Json<PutOverwrite>,
) -> AppResult<Json<Channel>> {
    let (gid, before) = channel_perm(&state, cid, user, perms::MANAGE_ROLES).await?;
    // Administrator only means something on roles.
    let (allow, deny) = (body.allow & perms::ALL & !perms::ADMINISTRATOR, body.deny & perms::ALL & !perms::ADMINISTRATOR);
    if allow & deny != 0 {
        return Err(bad("a permission can't be both allowed and denied"));
    }
    let mine = before.in_channel(user, cid);
    let old = db::channel(&state.db, cid).await?.overwrites.into_iter().find(|o| o.id == target && o.kind == body.kind);
    let changed = (allow ^ old.as_ref().map_or(0, |o| o.allow)) | (deny ^ old.as_ref().map_or(0, |o| o.deny));
    if changed & !mine != 0 {
        return Err(bad("you can only change permissions you have in this channel"));
    }
    let known = match body.kind {
        OverwriteKind::Role => before.roles.contains_key(&target),
        OverwriteKind::Member => db::is_member(&state.db, gid, target).await?,
    };
    if !known {
        return Err(AppError::NotFound);
    }
    sqlx::query(
        "INSERT INTO channel_overwrites (channel_id, target_kind, target_id, allow, deny) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, target_kind, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny",
    )
    .bind(cid.0)
    .bind(body.kind.as_str())
    .bind(target.0)
    .bind(allow as i64)
    .bind(deny as i64)
    .execute(&state.db)
    .await?;
    overwrites_changed(&state, gid, cid, &before).await
}

pub async fn delete_overwrite(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((cid, kind, target)): Path<(Id, OverwriteKind, Id)>,
) -> AppResult<Json<Channel>> {
    let (gid, before) = channel_perm(&state, cid, user, perms::MANAGE_ROLES).await?;
    let old = db::channel(&state.db, cid).await?.overwrites.into_iter().find(|o| o.id == target && o.kind == kind).ok_or(AppError::NotFound)?;
    if (old.allow | old.deny) & !before.in_channel(user, cid) != 0 {
        return Err(bad("you can only change permissions you have in this channel"));
    }
    sqlx::query("DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_kind = $2 AND target_id = $3")
        .bind(cid.0)
        .bind(kind.as_str())
        .bind(target.0)
        .execute(&state.db)
        .await?;
    overwrites_changed(&state, gid, cid, &before).await
}

async fn overwrites_changed(state: &AppState, gid: Id, cid: Id, before: &GuildPerms) -> AppResult<Json<Channel>> {
    state.resync_visibility(gid, before).await?;
    let c = db::channel(&state.db, cid).await?;
    // Those who could see it before and still can get the new overwrites.
    let after = state.perms.guild(&state.db, gid).await?;
    state.hub.to_guild_where(gid, &ServerEvent::ChannelUpdate(c.clone()), |u| {
        before.can_in(u, cid, perms::VIEW_CHANNEL) && after.can_in(u, cid, perms::VIEW_CHANNEL)
    });
    Ok(Json(c))
}
