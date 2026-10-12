//! Uploaded pictures: server icons and banners, and avatars. They're cropped and resized
//! here, stored under a content hash, and served from `/api/files/...` (cached forever,
//! since a new picture gets a new name).

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::response::Response;
use proto::Id;
use proto::gateway::ServerEvent;
use proto::models::{AuditAction, Guild, User};
use proto::perms;
use sha2::{Digest, Sha256};

use super::require_perm;
use crate::audit::{self, Entry};
use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;
use crate::storage::Presentation;
use crate::thumbs::{self, Fit};

/// Largest picture accepted before resizing.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub const PREFIX: &str = "/api/files/";

/// Fits and stores a picture, returning its URL path.
async fn store(state: &AppState, folder: String, kind: &str, body: Bytes, fit: Fit) -> AppResult<String> {
    if body.is_empty() {
        return Err(bad("no picture"));
    }
    let (bytes, ct) = tokio::task::spawn_blocking(move || thumbs::picture(&body, fit))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .ok_or_else(|| bad("that isn't a PNG, JPEG, WebP or GIF image"))?;
    let hash: String = Sha256::digest(&bytes)[..8].iter().map(|b| format!("{b:02x}")).collect();
    let key = format!("{folder}/{kind}-{hash}.{}", if ct == "image/webp" { "webp" } else { "jpg" });
    state.storage.put(&key, ct, futures::stream::iter([Ok::<_, AppError>(Bytes::from(bytes))])).await?;
    Ok(format!("{PREFIX}{key}"))
}

/// Deletes a picture we stored, when it's replaced or removed (other URLs are left alone).
async fn forget(state: &AppState, url: Option<String>) {
    if let Some(key) = url.as_deref().and_then(|u| u.strip_prefix(PREFIX)) {
        let _ = state.storage.delete(key).await;
    }
}

async fn set_guild_picture(state: &AppState, user: Id, gid: Id, kind: &str, body: Option<Bytes>) -> AppResult<Json<Guild>> {
    require_perm(state, gid, user, perms::MANAGE_GUILD).await?;
    let before = db::guild(&state.db, gid).await?;
    let (old, fit, column) = match kind {
        "icon" => (before.icon_url.clone(), Fit::Square(256), "icon_url"),
        _ => (before.banner_url.clone(), Fit::Cover(960, 540), "banner_url"),
    };
    let url = match body {
        Some(b) => Some(store(state, format!("guild/{gid}"), kind, b, fit).await?),
        None => None,
    };
    // `column` is one of two literals above.
    sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE guilds SET {column} = $1 WHERE id = $2"))).bind(&url).bind(gid.0).execute(&state.db).await?;
    if old != url {
        forget(state, old).await;
    }
    let g = db::guild(&state.db, gid).await?;
    let entry = Entry::new(AuditAction::GuildUpdate, Some(gid), g.name.clone()).change(kind, before_label(&before, kind), url.as_ref().map(|_| "new picture"));
    audit::log(state, gid, user, entry).await;
    state.hub.to_guild(gid, &ServerEvent::GuildUpdate(g.clone()));
    Ok(Json(g))
}

fn before_label(g: &Guild, kind: &str) -> Option<&'static str> {
    let had = if kind == "icon" { g.icon_url.is_some() } else { g.banner_url.is_some() };
    had.then_some("old picture")
}

pub async fn put_icon(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, body: Bytes) -> AppResult<Json<Guild>> {
    set_guild_picture(&state, user, gid, "icon", Some(body)).await
}

pub async fn delete_icon(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<Json<Guild>> {
    set_guild_picture(&state, user, gid, "icon", None).await
}

pub async fn put_banner(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>, body: Bytes) -> AppResult<Json<Guild>> {
    set_guild_picture(&state, user, gid, "banner", Some(body)).await
}

pub async fn delete_banner(State(state): State<AppState>, Auth(user): Auth, Path(gid): Path<Id>) -> AppResult<Json<Guild>> {
    set_guild_picture(&state, user, gid, "banner", None).await
}

async fn set_avatar(state: &AppState, user: Id, body: Option<Bytes>) -> AppResult<Json<User>> {
    let old = db::user(&state.db, user).await?.avatar_url;
    let url = match body {
        Some(b) => Some(store(state, format!("avatar/{user}"), "avatar", b, Fit::Square(256)).await?),
        None => None,
    };
    sqlx::query("UPDATE users SET avatar_url = $1 WHERE id = $2").bind(&url).bind(user.0).execute(&state.db).await?;
    if old != url {
        forget(state, old).await;
    }
    Ok(Json(super::users::announce(state, user).await?))
}

pub async fn put_avatar(State(state): State<AppState>, Auth(user): Auth, body: Bytes) -> AppResult<Json<User>> {
    set_avatar(&state, user, Some(body)).await
}

pub async fn delete_avatar(State(state): State<AppState>, Auth(user): Auth) -> AppResult<Json<User>> {
    set_avatar(&state, user, None).await
}

/// Public: icons and avatars show on invites and to anyone who sees the person.
pub async fn serve(State(state): State<AppState>, Path(key): Path<String>, req: Request) -> AppResult<Response> {
    let ok = (key.starts_with("guild/") || key.starts_with("avatar/") || key.starts_with("embed/")) && !key.contains("..") && key.len() < 200;
    let ct = match key.rsplit_once('.').map(|(_, e)| e) {
        Some("webp") => "image/webp",
        Some("jpg") => "image/jpeg",
        _ => return Err(AppError::NotFound),
    };
    if !ok {
        return Err(AppError::NotFound);
    }
    state.storage.serve(&key, req, Presentation { content_type: ct, disposition: "inline" }).await
}
