use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::{ChannelRef, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::require_owner;
use crate::auth::Auth;
use crate::db;
use crate::error::{AppResult, bad};
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
    require_owner(&state, gid, user).await?;
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
    state.hub.to_guild(gid, &ServerEvent::ChannelCreate(c.clone()));
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
    require_owner(&state, c.guild_id, user).await?;
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
    state.hub.to_guild(c.guild_id, &ServerEvent::ChannelUpdate(c.clone()));
    Ok(Json(c))
}

pub async fn delete(State(state): State<AppState>, Auth(user): Auth, Path(cid): Path<Id>) -> AppResult<()> {
    let c = db::channel(&state.db, cid).await?;
    require_owner(&state, c.guild_id, user).await?;
    let mut tx = state.db.begin().await?;
    // Children of a deleted category become top level.
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = $1").bind(cid.0).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channels WHERE id = $1").bind(cid.0).execute(&mut *tx).await?;
    tx.commit().await?;
    if c.kind == ChannelKind::Category {
        for ch in db::channels(&state.db, c.guild_id).await? {
            state.hub.to_guild(c.guild_id, &ServerEvent::ChannelUpdate(ch));
        }
    }
    state.channel_guild.remove(&cid);
    state.hub.to_guild(c.guild_id, &ServerEvent::ChannelDelete(ChannelRef { id: cid, guild_id: c.guild_id }));
    Ok(())
}
