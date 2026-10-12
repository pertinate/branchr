use axum::Json;
use axum::extract::State;
use proto::gateway::ServerEvent;
use proto::models::User;
use serde::Deserialize;

use crate::auth::Auth;
use crate::db;
use crate::error::{AppResult, bad};
use crate::state::AppState;

pub async fn me(State(state): State<AppState>, Auth(user): Auth) -> AppResult<Json<User>> {
    Ok(Json(db::user(&state.db, user).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchMe {
    display_name: Option<String>,
    avatar_url: Option<Option<String>>,
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
    if let Some(url) = body.avatar_url {
        if url.as_ref().is_some_and(|u| !u.starts_with("https://") || u.len() > 512) {
            return Err(bad("avatar must be an https url"));
        }
        sqlx::query("UPDATE users SET avatar_url = $1 WHERE id = $2").bind(url).bind(user.0).execute(&state.db).await?;
    }
    let u = db::user(&state.db, user).await?;
    // Everyone sharing a guild with this user needs the new profile.
    let ev = ServerEvent::UserUpdate(u.clone());
    for g in db::guild_ids_for_user(&state.db, user).await? {
        state.hub.to_guild(g, &ev);
    }
    state.hub.to_user(user, &ev);
    Ok(Json(u))
}
