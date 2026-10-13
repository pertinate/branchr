use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{ChannelRef, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::{channel_perm, require_perm};
use proto::perms::{self, Permissions};
use crate::audit::{self, Entry};
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
    let name = if matches!(kind, ChannelKind::Text | ChannelKind::Forum) {
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
    if body.kind == ChannelKind::Thread {
        return Err(bad("start threads from a channel"));
    }
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
    audit::log(&state, gid, user, Entry::new(AuditAction::ChannelCreate, Some(id), c.name.clone())).await;
    state.to_channel(gid, id, &ServerEvent::ChannelCreate(c.clone())).await;
    Ok(Json(c))
}

/// Six hours, as on Discord.
const MAX_SLOWMODE: u32 = 6 * 3600;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchChannel {
    name: Option<String>,
    topic: Option<Option<String>>,
    position: Option<i32>,
    slowmode_secs: Option<u32>,
}

pub async fn patch(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(cid): Path<Id>,
    Json(body): Json<PatchChannel>,
) -> AppResult<Json<Channel>> {
    let c = db::channel(&state.db, cid).await?;
    require_perm(&state, c.guild_id, user, perms::MANAGE_CHANNELS).await?;
    let before = c.clone();
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
    if let Some(secs) = body.slowmode_secs {
        if secs > MAX_SLOWMODE {
            return Err(bad("slow mode is at most 6 hours"));
        }
        sqlx::query("UPDATE channels SET slowmode = $1 WHERE id = $2").bind(secs as i64).bind(cid.0).execute(&state.db).await?;
        // Its threads' cached values too (they follow it).
        state.slowmode.clear();
    }
    if let Some(pos) = body.position {
        sqlx::query("UPDATE channels SET position = $1 WHERE id = $2").bind(pos).bind(cid.0).execute(&state.db).await?;
    }
    let c = db::channel(&state.db, cid).await?;
    let entry = Entry::new(AuditAction::ChannelUpdate, Some(cid), c.name.clone())
        .change("name", Some(&before.name), Some(&c.name))
        .change("topic", before.topic.as_ref(), c.topic.as_ref())
        .change("slow mode", Some(&format!("{}s", before.slowmode_secs)), Some(&format!("{}s", c.slowmode_secs)));
    // Reordering alone isn't worth an entry.
    if !entry.changes.is_empty() {
        audit::log(&state, c.guild_id, user, entry).await;
    }
    state.to_channel(c.guild_id, cid, &ServerEvent::ChannelUpdate(c.clone())).await;
    Ok(Json(c))
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path(cid): Path<Id>) -> AppResult<()> {
    let c = db::channel(&state.db, cid).await?;
    // Whoever started a thread can delete it too.
    if !(c.kind == ChannelKind::Thread && c.owner_id == Some(user)) {
        require_perm(&state, c.guild_id, user, perms::MANAGE_CHANNELS).await?;
    }
    let threads: Vec<(i64,)> = sqlx::query_as("SELECT id FROM channels WHERE parent_id = $1 AND kind = 'thread'").bind(cid.0).fetch_all(&state.db).await?;
    let was_system = db::guild(&state.db, c.guild_id).await?.system_channel_id == Some(cid);
    let mut tx = state.db.begin().await?;
    // A channel's threads go with it; a category's channels become top level.
    sqlx::query("DELETE FROM channels WHERE parent_id = $1 AND kind = 'thread'").bind(cid.0).execute(&mut *tx).await?;
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = $1").bind(cid.0).execute(&mut *tx).await?;
    sqlx::query("UPDATE guilds SET system_channel_id = NULL WHERE system_channel_id = $1").bind(cid.0).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(cid.0).execute(&mut *tx).await?;
    tx.commit().await?;
    if c.kind == ChannelKind::Category {
        for ch in db::channels(&state.db, c.guild_id).await?.into_iter().filter(|ch| ch.parent_id.is_none()) {
            state.to_channel(c.guild_id, ch.id, &ServerEvent::ChannelUpdate(ch)).await;
        }
    }
    // Told to whoever could see it, by the permissions cached from before the delete.
    for (t,) in threads {
        state.to_channel(c.guild_id, Id(t), &ServerEvent::ChannelDelete(ChannelRef { id: Id(t), guild_id: c.guild_id })).await;
        state.channel_guild.remove(&Id(t));
    }
    state.to_channel(c.guild_id, cid, &ServerEvent::ChannelDelete(ChannelRef { id: cid, guild_id: c.guild_id })).await;
    state.channel_guild.remove(&cid);
    state.perms.invalidate(c.guild_id);
    audit::log(&state, c.guild_id, user, Entry::new(AuditAction::ChannelDelete, Some(cid), c.name)).await;
    // It may have been where join messages went.
    let g = db::guild(&state.db, c.guild_id).await?;
    if was_system {
        state.hub.to_guild(c.guild_id, &ServerEvent::GuildUpdate(g));
    }
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
    if db::channel(&state.db, cid).await?.kind == ChannelKind::Thread {
        return Err(bad("threads follow their channel's permissions"));
    }
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
    let c = overwrites_changed(&state, gid, cid, &before).await?;
    let entry = Entry::new(AuditAction::ChannelOverwriteUpdate, Some(cid), c.name.clone())
        .change(&format!("{} {} allow", body.kind.as_str(), target), old.as_ref().map(|o| o.allow), Some(allow))
        .change(&format!("{} {} deny", body.kind.as_str(), target), old.as_ref().map(|o| o.deny), Some(deny));
    audit::log(&state, gid, user, entry).await;
    Ok(c)
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
    let c = overwrites_changed(&state, gid, cid, &before).await?;
    let entry = Entry::new(AuditAction::ChannelOverwriteDelete, Some(cid), c.name.clone()).change(&format!("{} {}", kind.as_str(), target), Some("set"), None);
    audit::log(&state, gid, user, entry).await;
    Ok(c)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThread {
    name: Option<String>,
    /// Start it from this message in the channel.
    message_id: Option<Id>,
}

/// Starts a thread under a text channel, or a post in a forum (a thread with a title; its
/// first message is posted into it next); anyone who can post there can.
pub async fn create_thread(State(state): State<AppState>, Auth(user): Auth, Path(cid): Path<Id>, Json(body): Json<CreateThread>) -> AppResult<Json<Channel>> {
    let (gid, _) = super::channel_perm(&state, cid, user, perms::SEND_MESSAGES).await?;
    let parent = db::channel(&state.db, cid).await?;
    let forum = parent.kind == ChannelKind::Forum;
    if !matches!(parent.kind, ChannelKind::Text | ChannelKind::Forum) {
        return Err(bad("threads start in text channels"));
    }
    if forum && (body.message_id.is_some() || body.name.as_ref().is_none_or(|n| n.trim().is_empty())) {
        return Err(bad("a forum post needs a title"));
    }
    let starter = match body.message_id {
        Some(mid) => {
            let m = db::message(&state.db, mid, user).await?;
            if m.channel_id != cid {
                return Err(AppError::NotFound);
            }
            Some(m)
        }
        None => None,
    };
    // Unnamed: after the message it starts from.
    let fallback = starter.as_ref().map(|m| m.content.chars().take(40).collect::<String>()).filter(|s| !s.trim().is_empty());
    let name = body.name.filter(|n| !n.trim().is_empty()).or(fallback).unwrap_or_else(|| "thread".into());
    let name = name.trim().chars().take(100).collect::<String>();
    let id = state.ids.next();
    sqlx::query("INSERT INTO channels (id, guild_id, name, kind, parent_id, position, starter_message_id, owner_id) VALUES ($1, $2, $3, 'thread', $4, 0, $5, $6)")
        .bind(id.0)
        .bind(gid.0)
        .bind(&name)
        .bind(cid.0)
        .bind(body.message_id.map(|m| m.0))
        .bind(user.0)
        .execute(&state.db)
        .await
        .map_err(|e| match e.as_database_error() {
            Some(d) if d.is_unique_violation() => AppError::Conflict("that message already has a thread".into()),
            _ => e.into(),
        })?;
    state.perms.invalidate(gid);
    let c = db::channel(&state.db, id).await?;
    state.to_channel(gid, id, &ServerEvent::ChannelCreate(c.clone())).await;
    Ok(Json(c))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    id: Id,
    position: i32,
    /// The category it's in (none at the top); categories themselves have none.
    parent_id: Option<Id>,
}

/// Reorders channels and categories, and moves channels between categories, in one go
/// (what a drag in the channel list sends).
pub async fn reorder(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, Json(body): Json<Vec<Placement>>) -> AppResult<axum::http::StatusCode> {
    require_perm(&state, gid, user, perms::MANAGE_CHANNELS).await?;
    if body.is_empty() || body.len() > 500 {
        return Err(bad("send 1-500 placements"));
    }
    let all: std::collections::HashMap<Id, Channel> = db::channels(&state.db, gid).await?.into_iter().map(|c| (c.id, c)).collect();
    for p in &body {
        let c = all.get(&p.id).ok_or_else(|| bad("unknown channel"))?;
        match c.kind {
            ChannelKind::Thread => return Err(bad("threads stay with their channel")),
            ChannelKind::Category if p.parent_id.is_some() => return Err(bad("categories can't be nested")),
            _ => {}
        }
        if let Some(parent) = p.parent_id
            && all.get(&parent).is_none_or(|c| c.kind != ChannelKind::Category)
        {
            return Err(bad("channels go in categories"));
        }
    }
    let mut tx = state.db.begin().await?;
    for p in &body {
        sqlx::query("UPDATE channels SET position = $1, parent_id = $2 WHERE id = $3 AND guild_id = $4")
            .bind(p.position)
            .bind(p.parent_id.map(|i| i.0))
            .bind(p.id.0)
            .bind(gid.0)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    for p in &body {
        let c = db::channel(&state.db, p.id).await?;
        state.to_channel(gid, p.id, &ServerEvent::ChannelUpdate(c)).await;
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}
