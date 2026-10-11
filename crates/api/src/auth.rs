use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::Json;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use proto::Id;
use proto::models::{AuthResponse, User};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};

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
    let row: Option<(i64,)> = sqlx::query_as("SELECT user_id FROM sessions WHERE token_hash = ?")
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
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)")
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

pub async fn register(State(state): State<AppState>, Json(body): Json<Register>) -> AppResult<Json<AuthResponse>> {
    if !state.config.open_registration {
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
        "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
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
    let row: Option<(i64, String)> = sqlx::query_as("SELECT id, password_hash FROM users WHERE username = ?")
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
    let token = create_session(&state, id).await?;
    Ok(Json(AuthResponse { token, user: db::user(&state.db, id).await? }))
}

pub async fn logout(State(state): State<AppState>, parts: axum::http::HeaderMap) -> AppResult<()> {
    if let Some(token) = parts
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        let h = hash_token(token);
        state.sessions.remove(&h);
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(&h[..]).execute(&state.db).await?;
    }
    Ok(())
}
