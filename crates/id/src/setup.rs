//! Setting up a hub from the website: a signed-in person gets a one-time code; the hub, started
//! with it (BRANCHR_SETUP), trades it for its key and secret and is already theirs.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;
use crate::error::{Error, Result, bad};
use crate::instances::Registered;
use crate::oauth::authed;

const TTL_HOURS: i32 = 24;
/// Unused codes one account may hold at once.
const MAX_OPEN: i64 = 10;
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn hash(s: &str) -> Vec<u8> {
    Sha256::digest(s.as_bytes()).to_vec()
}

/// `BRS-XXXX-XXXX-XXXX-XXXX`: long enough not to guess, easy to read.
fn new_code() -> String {
    let mut rng = rand::rng();
    let groups: Vec<String> = (0..4).map(|_| (0..4).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()).collect();
    format!("BRS-{}", groups.join("-"))
}

fn normalize(code: &str) -> String {
    code.trim().to_ascii_uppercase()
}

#[derive(Deserialize)]
pub struct NewCode {
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    pub code: String,
    pub expires_in_hours: i32,
}

pub async fn create(State(s): State<AppState>, headers: HeaderMap, Json(b): Json<NewCode>) -> Result<Json<Code>> {
    let account = authed(&s, &headers).await?;
    let name = b.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("invalid_request", "a hub's name is 1-100 characters"));
    }
    let (open,): (i64,) = sqlx::query_as("SELECT count(*) FROM setup_codes WHERE account_id = $1 AND instance_id IS NULL AND expires_at > now()")
        .bind(account)
        .fetch_one(&s.db)
        .await?;
    if open >= MAX_OPEN {
        return Err(bad("invalid_request", "you have plenty of unused setup codes; use one of those"));
    }
    let code = new_code();
    sqlx::query("INSERT INTO setup_codes (code_hash, account_id, name, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))")
        .bind(hash(&code))
        .bind(account)
        .bind(name)
        .bind(TTL_HOURS)
        .execute(&s.db)
        .await?;
    Ok(Json(Code { code, expires_in_hours: TTL_HOURS }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeStatus {
    pub name: String,
    /// The hub's key, once a hub has used the code.
    pub instance_id: Option<Uuid>,
    pub expired: bool,
}

/// For the setup page: has a hub come in with this code yet?
pub async fn status(State(s): State<AppState>, headers: HeaderMap, Path(code): Path<String>) -> Result<Json<CodeStatus>> {
    let account = authed(&s, &headers).await?;
    let row: Option<(String, Option<Uuid>, bool)> =
        sqlx::query_as("SELECT name, instance_id, expires_at < now() FROM setup_codes WHERE code_hash = $1 AND account_id = $2")
            .bind(hash(&normalize(&code)))
            .bind(account)
            .fetch_optional(&s.db)
            .await?;
    let (name, instance_id, expired) = row.ok_or(Error::NotFound)?;
    Ok(Json(CodeStatus { name, instance_id, expired }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redeem {
    code: String,
    #[serde(default)]
    public_url: String,
}

/// A hub's first start with BRANCHR_SETUP: the code is its credential, once.
pub async fn redeem(State(s): State<AppState>, Json(b): Json<Redeem>) -> Result<Json<Registered>> {
    if b.public_url.len() > 300 || !b.public_url.is_empty() && url::Url::parse(&b.public_url).is_err() {
        return Err(bad("invalid_request", "publicUrl must be a URL"));
    }
    let mut tx = s.db.begin().await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT account_id, name FROM setup_codes WHERE code_hash = $1 AND instance_id IS NULL AND expires_at > now() FOR UPDATE",
    )
    .bind(hash(&normalize(&b.code)))
    .fetch_optional(&mut *tx)
    .await?;
    let Some((owner, name)) = row else {
        return Err(bad("invalid_grant", "that setup code is unknown, used or expired; get a new one"));
    };
    if s.banned.contains(&owner) {
        return Err(Error::Forbidden("this account is banned from branchr".into()));
    }
    let id = Uuid::now_v7();
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    let secret = B64.encode(raw);
    sqlx::query("INSERT INTO instances (id, secret_hash, name, public_url, owner_id, last_seen_at) VALUES ($1, $2, $3, $4, $5, now())")
        .bind(id)
        .bind(hash(&secret))
        .bind(&name)
        .bind(&b.public_url)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE setup_codes SET instance_id = $1 WHERE code_hash = $2").bind(id).bind(hash(&normalize(&b.code))).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(Registered { instance_id: id, secret, claim_code: String::new() }))
}
