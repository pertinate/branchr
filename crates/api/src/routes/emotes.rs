use axum::Json;
use axum::extract::{Path, Query, State};
use proto::Id;
use proto::gateway::{EmoteRef, ServerEvent};
use proto::models::*;
use serde::Deserialize;

use super::{require_member, require_perm};
use proto::perms;
use crate::auth::Auth;
use crate::db;
use crate::emote_providers::{Link, ProviderError, parse_link};
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

const MAX_EMOTES: i64 = 1000;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    provider: Option<String>,
    limit: Option<u32>,
}

pub async fn search(
    State(state): State<AppState>,
    Auth(_): Auth,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<Vec<ExternalEmote>>> {
    let query = q.q.trim();
    if query.is_empty() || query.len() > 100 {
        return Ok(Json(vec![]));
    }
    let provider = match q.provider.as_deref() {
        None => EmoteProvider::SevenTv,
        Some(p) => EmoteProvider::parse(p).ok_or_else(|| bad("unknown emote provider"))?,
    };
    let res = state.emotes.search(provider, query, q.limit.unwrap_or(48).clamp(1, 100)).await?;
    Ok(Json((*res).clone()))
}

fn valid_name(n: &str) -> bool {
    (1..=64).contains(&n.len()) && n.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '!' || c == '?')
}

async fn insert(state: &AppState, gid: Id, e: &ExternalEmote) -> AppResult<Option<Emote>> {
    if !valid_name(&e.name) {
        return Ok(None);
    }
    let id = state.ids.next();
    let r = sqlx::query(
        "INSERT INTO emotes (id, guild_id, name, provider, provider_id, animated, width, height)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE (SELECT COUNT(*) FROM emotes WHERE guild_id = $2) < $9 ON CONFLICT DO NOTHING",
    )
    .bind(id.0)
    .bind(gid.0)
    .bind(&e.name)
    .bind(e.provider.as_str())
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

/// Add one emote, by provider + id or by a link to it on any supported site.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddEmote {
    provider: Option<EmoteProvider>,
    provider_id: Option<String>,
    url: Option<String>,
    name: Option<String>,
}

pub async fn add(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<AddEmote>,
) -> AppResult<Json<Emote>> {
    require_member(&state, gid, user).await?;
    let (provider, provider_id) = match (body.url.as_deref(), body.provider_id) {
        (Some(url), _) => match parse_link(url) {
            Some(Link::Emote(p, id)) => (p, id),
            Some(_) => return Err(bad("that link is a set or channel; use Import instead")),
            None => return Err(bad("not a 7TV, BetterTTV or FrankerFaceZ emote link")),
        },
        (None, Some(id)) => (body.provider.unwrap_or(EmoteProvider::SevenTv), id),
        (None, None) => return Err(bad("providerId or url is required")),
    };
    let name = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
    let e = state.emotes.emote(provider, &provider_id, name).await?;
    if !valid_name(&e.name) {
        return Err(bad("emote names may contain letters, numbers, _ - ! ?"));
    }
    insert(&state, gid, &e)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::Conflict("an emote with that name exists, or the emote limit was reached".into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSet {
    /// A 7TV set/user link or id, an FFZ channel link, a Twitch channel link or name.
    #[serde(alias = "setId")]
    source: String,
    /// For Twitch channels: which providers to pull from (default: all).
    providers: Option<Vec<EmoteProvider>>,
}

/// Imports a whole emote set or a Twitch channel's emotes, skipping names that already
/// exist. For channels, earlier providers win name clashes (7TV, then BTTV, then FFZ).
pub async fn import_set(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path(gid): Path<Id>,
    Json(body): Json<ImportSet>,
) -> AppResult<Json<EmoteImport>> {
    require_perm(&state, gid, user, perms::MANAGE_EMOTES).await?;
    let p = &state.emotes;
    let lists = match parse_link(&body.source) {
        Some(Link::SevenTvSet(id)) => vec![p.seventv_set(&id).await?],
        Some(Link::SevenTvUser(id)) => vec![p.seventv_user(&id).await?],
        Some(Link::FfzChannel(login)) => vec![p.twitch_channel(EmoteProvider::Ffz, &login).await?],
        Some(Link::Twitch(login)) => {
            let want = body.providers.unwrap_or(EmoteProvider::ALL.to_vec());
            let fetches = EmoteProvider::ALL.into_iter().filter(|p| want.contains(p)).map(|pr| p.twitch_channel(pr, &login));
            let mut lists = Vec::new();
            for r in futures::future::join_all(fetches).await {
                match r {
                    Ok(l) => lists.push(l),
                    // Channel unknown to this provider.
                    Err(ProviderError::NotFound) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            lists
        }
        Some(Link::BttvUser(_)) => {
            return Err(bad("BetterTTV user pages can't be read publicly; enter the user's Twitch channel instead"));
        }
        Some(Link::Emote(..)) => return Err(bad("that's a single emote; use Add instead")),
        None => return Err(bad("enter an emote set link, or a Twitch channel name")),
    };
    let found: usize = lists.iter().map(|l| l.len()).sum();
    if found == 0 {
        return Err(AppError::NotFound);
    }
    let mut added = Vec::new();
    for e in lists.iter().flat_map(|l| l.iter()) {
        if let Some(e) = insert(&state, gid, e).await? {
            added.push(e);
        }
    }
    Ok(Json(EmoteImport { added, found: found as u32 }))
}

#[derive(Deserialize)]
pub struct RenameEmote {
    name: String,
}

/// Renames an emote in this guild, e.g. to resolve a clash or to taste. The provider's
/// image stays the same; only the name used here changes.
pub async fn rename(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((gid, eid)): Path<(Id, Id)>,
    Json(body): Json<RenameEmote>,
) -> AppResult<Json<Emote>> {
    require_perm(&state, gid, user, perms::MANAGE_EMOTES).await?;
    let name = body.name.trim();
    if !valid_name(name) {
        return Err(bad("emote names are 1-64 letters, numbers, _ - ! ?"));
    }
    let r = sqlx::query("UPDATE emotes SET name = $1 WHERE id = $2 AND guild_id = $3")
        .bind(name)
        .bind(eid.0)
        .bind(gid.0)
        .execute(&state.db)
        .await
        .map_err(|e| match e.as_database_error() {
            Some(d) if d.is_unique_violation() => AppError::Conflict(format!("an emote named {name} already exists")),
            _ => e.into(),
        })?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let emote = db::emote(&state.db, eid).await?;
    state.hub.to_guild(gid, &ServerEvent::EmoteUpdate(emote.clone()));
    Ok(Json(emote))
}

pub async fn remove(
    State(state): State<AppState>,
    Auth(user): Auth,
    Path((gid, eid)): Path<(Id, Id)>,
) -> AppResult<()> {
    require_perm(&state, gid, user, perms::MANAGE_EMOTES).await?;
    let r = sqlx::query("DELETE FROM emotes WHERE id = $1 AND guild_id = $2").bind(eid.0).bind(gid.0).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.hub.to_guild(gid, &ServerEvent::EmoteDelete(EmoteRef { id: eid, guild_id: gid }));
    Ok(())
}

#[derive(Deserialize)]
pub struct LookupQuery {
    /// Comma-separated emote ids.
    ids: String,
}

/// Emotes by id, from any server. Lets clients render reactions with emotes from servers
/// they aren't in. Only the emote itself is returned, not which server it belongs to.
pub async fn lookup(
    State(state): State<AppState>,
    Auth(_): Auth,
    Query(q): Query<LookupQuery>,
) -> AppResult<Json<Vec<Emote>>> {
    let mut ids: Vec<i64> = q.ids.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() > 100 {
        return Err(bad("at most 100 ids"));
    }
    Ok(Json(db::emotes_by_ids(&state.db, &ids, None).await?))
}
