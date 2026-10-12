use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::Json;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use proto::Id;
use proto::models::{AuthResponse, InstanceInfo, User};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::config::AuthMode;
use crate::db;
use crate::error::{AppError, AppResult, bad};
use crate::state::AppState;

/// Authenticated user id, taken from `Authorization: Bearer <token>`.
pub struct Auth(pub Id);

impl FromRequestParts<AppState> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(AppError::Unauthorized)?;
        user_for_token(state, token).await?.map(Auth).ok_or(AppError::Unauthorized)
    }
}

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub async fn user_for_token(state: &AppState, token: &str) -> AppResult<Option<Id>> {
    let h = hash_token(token);
    if let Some(id) = state.sessions.get(&h) {
        return Ok(Some(*id));
    }
    let row: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM sessions WHERE token_hash = $1")
        .bind(&h[..])
        .fetch_optional(&state.db)
        .await?;
    Ok(row.map(|(id,)| {
        state.sessions.insert(h, Id(id));
        Id(id)
    }))
}

async fn create_session(state: &AppState, user: Id) -> AppResult<String> {
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let token = B64.encode(raw);
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at) VALUES ($1, $2, $3)")
        .bind(&hash_token(&token)[..])
        .bind(user.0)
        .bind(db::now_ms())
        .execute(&state.db)
        .await?;
    Ok(token)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Register {
    username: String,
    password: String,
    display_name: Option<String>,
}

fn valid_username(u: &str) -> bool {
    (2..=32).contains(&u.len()) && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Banned from this host by its owner.
async fn refuse_banned(state: &AppState, user: Id) -> AppResult<()> {
    let banned: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM instance_bans WHERE user_id = $1").bind(user.0).fetch_optional(&state.db).await?;
    match banned {
        Some(_) => Err(AppError::BadRequest("you're banned from this host".into())),
        None => Ok(()),
    }
}

/// Password accounts are off when the server only takes branchr accounts.
fn local_allowed(state: &AppState) -> AppResult<()> {
    if state.config.auth_mode == AuthMode::Federated {
        return Err(bad("this server uses branchr accounts: sign in with Discord"));
    }
    Ok(())
}

pub async fn register(State(state): State<AppState>, Json(body): Json<Register>) -> AppResult<Json<AuthResponse>> {
    local_allowed(&state)?;
    if !state.open_registration.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(AppError::Forbidden);
    }
    let username = body.username.trim().to_string();
    if !valid_username(&username) {
        return Err(bad("username must be 2-32 characters of letters, numbers, _ or ."));
    }
    if body.password.len() < 8 || body.password.len() > 256 {
        return Err(bad("password must be at least 8 characters"));
    }
    let display_name = body
        .display_name
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty() && d.chars().count() <= 32)
        .unwrap_or_else(|| username.clone());

    let password = body.password;
    let hash = tokio::task::spawn_blocking(move || {
        let mut bytes = [0u8; 16];
        rand::rng().fill_bytes(&mut bytes);
        let salt = SaltString::encode_b64(&bytes).expect("16 byte salt");
        Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string())
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?;

    let id = state.ids.next();
    let res = sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(id.0)
    .bind(&username)
    .bind(&display_name)
    .bind(&hash)
    .bind(db::now_ms())
    .execute(&state.db)
    .await;
    match res {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("username taken".into()));
        }
        r => r?,
    };

    let token = create_session(&state, id).await?;
    Ok(Json(AuthResponse { token, user: User { id, username, display_name, avatar_url: None } }))
}

#[derive(Deserialize)]
pub struct Login {
    username: String,
    password: String,
}

pub async fn login(State(state): State<AppState>, Json(body): Json<Login>) -> AppResult<Json<AuthResponse>> {
    local_allowed(&state)?;
    let row: Option<(i64, String)> = sqlx::query_as("SELECT id, password_hash FROM users WHERE lower(username) = lower($1)")
        .bind(body.username.trim())
        .fetch_optional(&state.db)
        .await?;
    let Some((id, hash)) = row else {
        return Err(AppError::Unauthorized);
    };
    let ok = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|h| Argon2::default().verify_password(body.password.as_bytes(), &h).is_ok())
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    if !ok {
        return Err(AppError::Unauthorized);
    }
    let id = Id(id);
    refuse_banned(&state, id).await?;
    let token = create_session(&state, id).await?;
    Ok(Json(AuthResponse { token, user: db::user(&state.db, id).await? }))
}

#[derive(Deserialize)]
pub struct FederatedLogin {
    /// A pass from branchr ID for this server.
    token: String,
}

/// Logs in with a branchr account, creating the local user on first visit.
pub async fn federated(State(state): State<AppState>, Json(body): Json<FederatedLogin>) -> AppResult<Json<AuthResponse>> {
    let fed = state.federation.as_ref().ok_or_else(|| bad("this server doesn't accept branchr accounts"))?;
    let pass = fed.verify(&body.token).await.ok_or(AppError::Unauthorized)?;
    let display_name: String = pass.name.trim().chars().take(32).collect();
    let display_name = if display_name.is_empty() { pass.username.clone() } else { display_name };
    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE global_id = $1").bind(&pass.sub).fetch_optional(&state.db).await?;
    let id = match existing {
        Some((id,)) => {
            refuse_banned(&state, Id(id)).await?;
            // The branchr profile is the source of truth for name and avatar.
            sqlx::query("UPDATE users SET display_name = $1, avatar_url = $2 WHERE id = $3")
                .bind(&display_name)
                .bind(&pass.avatar)
                .bind(id)
                .execute(&state.db)
                .await?;
            Id(id)
        }
        None => {
            if !state.open_registration.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(AppError::Forbidden);
            }
            let id = state.ids.next();
            let username = crate::federation::free_username(&state.db, &pass.username).await?;
            // No password: "!" is never a valid hash, so password login can't match.
            sqlx::query(
                "INSERT INTO users (id, username, display_name, password_hash, avatar_url, created_at, global_id) VALUES ($1, $2, $3, '!', $4, $5, $6)",
            )
            .bind(id.0)
            .bind(&username)
            .bind(&display_name)
            .bind(&pass.avatar)
            .bind(db::now_ms())
            .bind(&pass.sub)
            .execute(&state.db)
            .await?;
            id
        }
    };
    let token = create_session(&state, id).await?;
    Ok(Json(AuthResponse { token, user: db::user(&state.db, id).await? }))
}

#[derive(serde::Serialize)]
pub struct LinkStatus {
    linked: bool,
}

/// Whether the logged-in user is tied to a branchr account.
pub async fn link_status(State(state): State<AppState>, Auth(user): Auth) -> AppResult<Json<LinkStatus>> {
    let (global,): (Option<String>,) = sqlx::query_as("SELECT global_id FROM users WHERE id = $1").bind(user.0).fetch_one(&state.db).await?;
    Ok(Json(LinkStatus { linked: global.is_some() }))
}

/// Ties the logged-in (password) user to a branchr account, so signing in with Discord
/// reaches this same user from then on.
pub async fn link(State(state): State<AppState>, Auth(user): Auth, Json(body): Json<FederatedLogin>) -> AppResult<Json<LinkStatus>> {
    let fed = state.federation.as_ref().ok_or_else(|| bad("this server doesn't accept branchr accounts"))?;
    let pass = fed.verify(&body.token).await.ok_or(AppError::Unauthorized)?;
    let owner: Option<(i64,)> = sqlx::query_as("SELECT id FROM users WHERE global_id = $1").bind(&pass.sub).fetch_optional(&state.db).await?;
    match owner {
        Some((id,)) if id == user.0 => return Ok(Json(LinkStatus { linked: true })),
        Some(_) => return Err(AppError::Conflict("that branchr account already has a user on this server".into())),
        None => {}
    }
    let r = sqlx::query("UPDATE users SET global_id = $1 WHERE id = $2 AND global_id IS NULL").bind(&pass.sub).bind(user.0).execute(&state.db).await;
    match r {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("that branchr account already has a user on this server".into()));
        }
        Ok(r) if r.rows_affected() == 0 => return Err(AppError::Conflict("this user is already linked to a branchr account".into())),
        r => {
            r?;
        }
    }
    Ok(Json(LinkStatus { linked: true }))
}

/// Which logins this server offers, for the login screen.
pub async fn instance_info(State(state): State<AppState>) -> Json<InstanceInfo> {
    let mode = match state.config.auth_mode {
        AuthMode::Local => "local",
        AuthMode::Federated => "federated",
        AuthMode::Both => "both",
    };
    let identity = state.federation.as_ref().and_then(|f| f.identity());
    Json(InstanceInfo {
        auth_mode: mode.into(),
        branchr_id_url: state.federation.as_ref().map(|f| f.id_url().to_string()),
        claimed: identity.as_ref().is_some_and(|i| i.owner.is_some()),
        instance_id: identity.map(|i| i.instance_id),
    })
}

pub async fn logout(State(state): State<AppState>, parts: axum::http::HeaderMap) -> AppResult<()> {
    if let Some(token) = parts
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        let h = hash_token(token);
        state.sessions.remove(&h);
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(&h[..]).execute(&state.db).await?;
    }
    Ok(())
}
