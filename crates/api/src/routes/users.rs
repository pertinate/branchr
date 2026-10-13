use axum::Json;
use axum::extract::{Path, State};
use proto::Id;
use proto::gateway::ServerEvent;
use proto::models::{NotifySettings, Profile, User};
use serde::Deserialize;

use crate::auth::Auth;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

pub async fn me(State(state): State<AppState>, Auth(user): Auth) -> AppResult<Json<User>> {
    Ok(Json(db::user(&state.db, user).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchMe {
    display_name: Option<String>,
    avatar_url: Option<Option<String>>,
    bio: Option<String>,
}

/// Longest "about me", in characters.
const BIO_MAX: usize = 190;

/// Someone's profile: yours, or of someone you share a community with.
pub async fn profile(State(state): State<AppState>, Auth(me): Auth, Path(uid): Path<Id>) -> AppResult<Json<Profile>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT u.bio FROM users u WHERE u.id = $1 AND ($1 = $2 OR EXISTS (
           SELECT 1 FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = $1 AND b.user_id = $2))",
    )
    .bind(uid.0)
    .bind(me.0)
    .fetch_optional(&state.db)
    .await?;
    let (bio,) = row.ok_or(AppError::NotFound)?;
    Ok(Json(Profile { user_id: uid, bio }))
}

pub async fn patch_me(
    State(state): State<AppState>,
    Auth(user): Auth,
    Json(body): Json<PatchMe>,
) -> AppResult<Json<User>> {
    if let Some(name) = body.display_name {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 32 {
            return Err(bad("display name must be 1-32 characters"));
        }
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2").bind(name).bind(user.0).execute(&state.db).await?;
    }
    if let Some(bio) = body.bio {
        let bio = bio.trim();
        if bio.chars().count() > BIO_MAX {
            return Err(bad("about me must be at most 190 characters"));
        }
        sqlx::query("UPDATE users SET bio = $1 WHERE id = $2").bind(bio).bind(user.0).execute(&state.db).await?;
    }
    if let Some(url) = body.avatar_url {
        if url.as_ref().is_some_and(|u| !u.starts_with("https://") || u.len() > 512) {
            return Err(bad("avatar must be an https url"));
        }
        sqlx::query("UPDATE users SET avatar_url = $1 WHERE id = $2").bind(url).bind(user.0).execute(&state.db).await?;
    }
    Ok(Json(announce(&state, user).await?))
}

/// Most ids each list of notify settings keeps.
const NOTIFY_MAX: usize = 2000;

/// Replaces your notify settings here, and tells your other sessions.
pub async fn put_notify_settings(State(state): State<AppState>, Auth(user): Auth, Json(body): Json<NotifySettings>) -> AppResult<Json<NotifySettings>> {
    if body.muted_guilds.len() > NOTIFY_MAX || body.muted_channels.len() > NOTIFY_MAX || body.levels.len() > NOTIFY_MAX {
        return Err(bad("too many notify settings"));
    }
    let data = serde_json::to_string(&body).expect("settings serialize");
    sqlx::query("INSERT INTO notify_settings (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data")
        .bind(user.0)
        .bind(data)
        .execute(&state.db)
        .await?;
    state.hub.to_user(user, &ServerEvent::NotifySettingsUpdate(body.clone()));
    Ok(Json(body))
}

/// Sends `user`'s current profile to everyone who shares a guild with them, and returns it.
pub async fn announce(state: &AppState, user: Id) -> AppResult<User> {
    let u = db::user(&state.db, user).await?;
    let ev = ServerEvent::UserUpdate(u.clone());
    for g in db::guild_ids_for_user(&state.db, user).await? {
        state.hub.to_guild(g, &ev);
    }
    state.hub.to_user(user, &ev);
    Ok(u)
}
