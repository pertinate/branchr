use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::{EmoteRef, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::{require_member, require_owner};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

const MAX_EMOTES: i64 = 1000;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    limit: Option<u32>,
}

pub async fn search(
    State(state): State<AppState>,
    Auth(_): Auth,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Vec<SevenTvEmote>>> {
    let query = q.q.trim();
    if query.is_empty() || query.len() > 100 {
        return Ok(Json(vec![]));
    }
    let res = state.seventv.search(query, q.limit.unwrap_or(48).clamp(1, 100)).await?;
    Ok(Json((*res).clone()))
}

fn valid_name(n: &str) -> bool {
    (1..=64).contains(&n.len()) && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '!' || c == '?')
}

async fn insert(state: &AppState, gid: Id, e: SevenTvEmote) -> AppResult<Option<Emote>> {
    if !valid_name(&e.name) {
        return Ok(None);
    }
    let id = state.ids.next();
    let r = sqlx::query(
        "INSERT OR IGNORE INTO emotes (id, guild_id, name, provider_id, animated, width, height)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE (SELECT COUNT(*) FROM emotes WHERE guild_id = ?2) < ?8",
    )
    .bind(id.0)
    .bind(gid.0)
    .bind(&e.name)
    .bind(&e.id)
    .bind(e.animated)
    .bind(e.width as i64)
    .bind(e.height as i64)
    .bind(MAX_EMOTES)
    .execute(&state.db)
    .await?;
    if r.rows_affected() == 0 {
        return Ok(None);
    }
    let emote = db::emote(&state.db, id).await?;
    state.hub.to_guild(gid, &ServerEvent::EmoteCreate(emote.clone()));
    Ok(Some(emote))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddEmote {
    provider_id: String,
    name: Option<String>,
}

pub async fn add(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<AddEmote>,
) -> AppResult<Json<Emote>> {
    require_member(&state, gid, user).await?;
    let mut e = state.seventv.emote(&body.provider_id).await.map_err(|_| AppError::NotFound)?;
    if let Some(name) = body.name {
        e.name = name.trim().to_string();
    }
    if !valid_name(&e.name) {
        return Err(bad("emote names may contain letters, numbers, _ - ! ?"));
    }
    insert(&state, gid, e)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::Conflict("an emote with that name exists, or the emote limit was reached".into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSet {
    set_id: String,
}

/// Imports a whole 7TV emote set, skipping names that already exist.
pub async fn import_set(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<ImportSet>,
) -> AppResult<Json<Vec<Emote>>> {
    require_owner(&state, gid, user).await?;
    // Accept a bare id or a 7tv.app url.
    let set_id = body.set_id.trim().trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();
    let emotes = state.seventv.emote_set(&set_id).await.map_err(|_| AppError::NotFound)?;
    let mut added = Vec::new();
    for e in emotes {
        if let Some(e) = insert(&state, gid, e).await? {
            added.push(e);
        }
    }
    Ok(Json(added))
}

pub async fn remove(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((gid, eid)): Path<(Id, Id)>,
) -> AppResult<()> {
    require_owner(&state, gid, user).await?;
    let r = sqlx::query("DELETE FROM emotes WHERE id = ? AND guild_id = ?").bind(eid.0).bind(gid.0).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.hub.to_guild(gid, &ServerEvent::EmoteDelete(EmoteRef { id: eid, guild_id: gid }));
    Ok(())
}
