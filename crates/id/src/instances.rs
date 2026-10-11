//! Self-hosted servers ("instances") that accept branchr accounts.
//!
//! 1. The server registers: `POST /instances` → id, secret and a claim code it shows its owner.
//! 2. The owner, signed in, enters the code: `POST /claims` makes them the server's owner.
//! 3. To open a server, a signed-in client asks for a pass: `POST /instances/{id}/token`,
//!    a short-lived JWT whose audience is that server. The server verifies it with our JWKS.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;
use crate::error::{Error, Result, bad};
use crate::oauth::authed;

/// How long a server's pass for a user lasts; the client asks for a new one each login.
pub const INSTANCE_TOKEN_TTL_SECS: u64 = 10 * 60;
const CLAIM_TTL_HOURS: i32 = 24;
/// No 0/O, 1/I/L: claim codes get read off a log and typed.
const CLAIM_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn hash(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}

fn claim_code() -> String {
    let mut rng = rand::rng();
    let c: String = (0..8).map(|_| CLAIM_ALPHABET[rng.random_range(0..CLAIM_ALPHABET.len())] as char).collect();
    format!("{}-{}", &c[..4], &c[4..])
}

/// Codes are typed by people: case, spaces and the dash don't matter.
fn normalize_code(c: &str) -> String {
    let c: String = c.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    if c.len() == 8 { format!("{}-{}", &c[..4], &c[4..]) } else { c }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Register {
    name: String,
    public_url: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    pub instance_id: Uuid,
    pub secret: String,
    pub claim_code: String,
}

pub async fn register(State(s): State<AppState>, Json(b): Json<Register>) -> Result<Json<Registered>> {
    let name = b.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("invalid_request", "name must be 1-100 characters"));
    }
    if b.public_url.len() > 300 || !b.public_url.is_empty() && url::Url::parse(&b.public_url).is_err() {
        return Err(bad("invalid_request", "publicUrl must be a URL"));
    }
    let id = Uuid::now_v7();
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let secret = B64.encode(raw);
    let code = claim_code();
    sqlx::query(
        "INSERT INTO instances (id, secret_hash, name, public_url, claim_code_hash, claim_expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))",
    )
    .bind(id)
    .bind(hash(&secret))
    .bind(name)
    .bind(&b.public_url)
    .bind(hash(&code))
    .bind(CLAIM_TTL_HOURS)
    .execute(&s.db)
    .await?;
    Ok(Json(Registered { instance_id: id, secret, claim_code: code }))
}

/// The instance behind `Authorization: Bearer <instance secret>`.
async fn instance_auth(s: &AppState, id: Uuid, headers: &HeaderMap) -> Result<()> {
    let secret = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(Error::Unauthorized)?;
    let ok: Option<(i32,)> =
        sqlx::query_as("SELECT 1 FROM instances WHERE id = $1 AND secret_hash = $2").bind(id).bind(hash(secret)).fetch_optional(&s.db).await?;
    ok.map(|_| ()).ok_or(Error::Unauthorized)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub claimed: bool,
    pub owner_id: Option<Uuid>,
}

/// For the server itself: has someone claimed it yet?
pub async fn status(State(s): State<AppState>, Path(id): Path<Uuid>, headers: HeaderMap) -> Result<Json<Status>> {
    instance_auth(&s, id, &headers).await?;
    let (owner_id,): (Option<Uuid>,) = sqlx::query_as("SELECT owner_id FROM instances WHERE id = $1").bind(id).fetch_one(&s.db).await?;
    Ok(Json(Status { claimed: owner_id.is_some(), owner_id }))
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaimCode {
    pub claim_code: String,
}

/// For the server itself: a fresh claim code (the last one expired).
pub async fn new_claim_code(State(s): State<AppState>, Path(id): Path<Uuid>, headers: HeaderMap) -> Result<Json<ClaimCode>> {
    instance_auth(&s, id, &headers).await?;
    let code = claim_code();
    let r = sqlx::query(
        "UPDATE instances SET claim_code_hash = $1, claim_expires_at = now() + make_interval(hours => $2) WHERE id = $3 AND owner_id IS NULL",
    )
    .bind(hash(&code))
    .bind(CLAIM_TTL_HOURS)
    .bind(id)
    .execute(&s.db)
    .await?;
    if r.rows_affected() == 0 {
        return Err(bad("invalid_request", "this server is already claimed"));
    }
    Ok(Json(ClaimCode { claim_code: code }))
}

#[derive(Deserialize)]
pub struct Claim {
    code: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Claimed {
    pub instance_id: Uuid,
    pub name: String,
    pub public_url: String,
}

/// A signed-in user claims a server with the code it showed them.
pub async fn claim(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<Claim>) -> Result<Json<Claimed>> {
    let account = authed(&s, &headers).await?;
    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        "UPDATE instances SET owner_id = $1, claim_code_hash = NULL, claim_expires_at = NULL
         WHERE claim_code_hash = $2 AND claim_expires_at > now() AND owner_id IS NULL
         RETURNING id, name, public_url",
    )
    .bind(account)
    .bind(hash(&normalize_code(&b.code)))
    .fetch_optional(&s.db)
    .await?;
    let (instance_id, name, public_url) = row.ok_or_else(|| bad("invalid_grant", "that claim code is wrong or expired"))?;
    tracing::info!("instance {instance_id} claimed by {account}");
    Ok(Json(Claimed { instance_id, name, public_url }))
}

/// What a server learns about a user from their pass.
#[derive(Serialize, Deserialize, Debug)]
pub struct InstanceClaims {
    pub iss: String,
    /// The server's instance id.
    pub aud: String,
    /// The branchr account id.
    pub sub: String,
    pub name: String,
    /// A username to start from (the Discord username); servers make it unique locally.
    pub username: String,
    pub avatar: Option<String>,
    pub iat: u64,
    pub exp: u64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstanceToken {
    pub token: String,
    pub expires_in: u64,
}

/// A pass for a signed-in user to log in to one server.
pub async fn token(State(s): State<AppState>, Path(id): Path<Uuid>, headers: HeaderMap) -> Result<Json<InstanceToken>> {
    let account = authed(&s, &headers).await?;
    let known: Option<(i32,)> = sqlx::query_as("SELECT 1 FROM instances WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    if known.is_none() {
        return Err(bad("invalid_request", "unknown server"));
    }
    let (name, avatar, username): (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT a.display_name, a.avatar_url, (SELECT username FROM identities i WHERE i.account_id = a.id ORDER BY updated_at DESC LIMIT 1)
         FROM accounts a WHERE a.id = $1",
    )
    .bind(account)
    .fetch_one(&s.db)
    .await?;
    let iat = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs();
    let token = s.keys.sign(&InstanceClaims {
        iss: s.config.public_url.clone(),
        aud: id.to_string(),
        sub: account.to_string(),
        username: username.unwrap_or_else(|| name.clone()),
        name,
        avatar,
        iat,
        exp: iat + INSTANCE_TOKEN_TTL_SECS,
    })?;
    Ok(Json(InstanceToken { token, expires_in: INSTANCE_TOKEN_TTL_SECS }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_codes() {
        let c = claim_code();
        assert_eq!(c.len(), 9);
        assert!(c.chars().all(|ch| ch == '-' || CLAIM_ALPHABET.contains(&(ch as u8))));
        assert_eq!(normalize_code(&c.to_lowercase().replace('-', " ")), c);
        assert_eq!(normalize_code(" abcd-efgh "), "ABCD-EFGH");
    }
}
