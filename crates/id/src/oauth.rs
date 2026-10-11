//! Sign-in for branchr clients: OAuth 2 authorization code with PKCE (S256), with Discord as
//! the identity provider.
//!
//!   client ─/authorize─▶ branchr ID ─▶ Discord ─/auth/discord/callback─▶ branchr ID
//!          ◀── redirect_uri?code&state ──────────────────────────────────────┘
//!   client ─/token (code + verifier)─▶ access token (JWT) + refresh token

use axum::Form;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::AppState;
use crate::discord;
use crate::error::{Error, Result, bad};

pub const ACCESS_TTL_SECS: u64 = 15 * 60;
const REFRESH_TTL_DAYS: i32 = 90;
const CODE_TTL_SECS: i32 = 120;
const REQUEST_TTL_MINS: i32 = 10;
/// The audience of tokens for branchr ID's own API (instances get their own).
pub const AUDIENCE: &str = "branchr-id";

fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::rng().fill_bytes(&mut b);
    B64.encode(b)
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs()
}

/// `redirect_uri` with `params` added to its query.
fn with_query(redirect_uri: &str, params: &[(&str, &str)]) -> String {
    let mut u = url::Url::parse(redirect_uri).expect("allow-listed redirects are URLs");
    u.query_pairs_mut().extend_pairs(params);
    u.into()
}

#[derive(Deserialize)]
pub struct AuthorizeQuery {
    redirect_uri: String,
    code_challenge: String,
    code_challenge_method: String,
    state: String,
}

/// Starts a sign-in: remembers the client's PKCE challenge and sends the user to Discord.
pub async fn authorize(State(s): State<AppState>, Query(q): Query<AuthorizeQuery>) -> Result<Redirect> {
    // Exact match only: the code goes wherever this points.
    if !s.config.redirects.iter().any(|r| *r == q.redirect_uri) || url::Url::parse(&q.redirect_uri).is_err() {
        return Err(bad("invalid_request", "redirect_uri is not allowed"));
    }
    if q.code_challenge_method != "S256" || q.code_challenge.len() != 43 {
        return Err(bad("invalid_request", "a S256 code_challenge is required"));
    }
    if q.state.is_empty() || q.state.len() > 256 {
        return Err(bad("invalid_request", "state must be 1-256 characters"));
    }
    let id = random_token();
    sqlx::query("INSERT INTO auth_requests (id, redirect_uri, code_challenge, client_state) VALUES ($1, $2, $3, $4)")
        .bind(&id)
        .bind(&q.redirect_uri)
        .bind(&q.code_challenge)
        .bind(&q.state)
        .execute(&s.db)
        .await?;
    Ok(Redirect::to(&discord::authorize_url(&s.config, &id)))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: String,
    error: Option<String>,
}

/// A page for failures we can't send back to the client (unknown or expired sign-in).
fn error_page(msg: &str) -> Response {
    Html(format!(
        "<!doctype html><meta charset=utf-8><title>branchr</title>\
         <body style=\"font:16px system-ui;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;height:100vh;margin:0\">\
         <div><h2>Couldn't sign in</h2><p>{msg}</p><p>Go back to branchr and try again.</p></div>"
    ))
    .into_response()
}

/// Discord sends the user back here.
pub async fn discord_callback(State(s): State<AppState>, Query(q): Query<CallbackQuery>) -> Result<Response> {
    let req: Option<(String, String, String)> = sqlx::query_as(
        "DELETE FROM auth_requests WHERE id = $1 AND created_at > now() - make_interval(mins => $2)
         RETURNING redirect_uri, code_challenge, client_state",
    )
    .bind(&q.state)
    .bind(REQUEST_TTL_MINS)
    .fetch_optional(&s.db)
    .await?;
    let Some((redirect_uri, challenge, client_state)) = req else {
        return Ok(error_page("This sign-in link expired or was already used."));
    };
    let Some(code) = q.code.filter(|_| q.error.is_none()) else {
        // Declined at Discord: tell the client so it can stop waiting.
        let error = q.error.as_deref().unwrap_or("access_denied");
        return Ok(Redirect::to(&with_query(&redirect_uri, &[("error", error), ("state", &client_state)])).into_response());
    };

    let user = discord::user_for_code(&s.http, &s.config, &code).await?;
    let account = upsert_discord_account(&s, &user).await?;

    let our_code = random_token();
    sqlx::query(
        "INSERT INTO auth_codes (code_hash, account_id, redirect_uri, code_challenge, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(hash(&our_code))
    .bind(account)
    .bind(&redirect_uri)
    .bind(&challenge)
    .bind(CODE_TTL_SECS as f64)
    .execute(&s.db)
    .await?;
    Ok(Redirect::to(&with_query(&redirect_uri, &[("code", &our_code), ("state", &client_state)])).into_response())
}

/// The account for a Discord user, created on first sign-in. Name and avatar follow Discord.
async fn upsert_discord_account(s: &AppState, u: &discord::DiscordUser) -> Result<Uuid> {
    // A second try covers two first sign-ins racing: the loser finds the winner's identity.
    match try_upsert(s, u).await? {
        Some(id) => Ok(id),
        None => try_upsert(s, u).await?.ok_or_else(|| Error::Internal(anyhow::anyhow!("identity upsert raced twice"))),
    }
}

async fn try_upsert(s: &AppState, u: &discord::DiscordUser) -> Result<Option<Uuid>> {
    let mut tx = s.db.begin().await?;
    let existing: Option<(Uuid,)> = sqlx::query_as("SELECT account_id FROM identities WHERE provider = 'discord' AND subject = $1 FOR UPDATE")
        .bind(&u.id)
        .fetch_optional(&mut *tx)
        .await?;
    let id = match existing {
        Some((id,)) => {
            sqlx::query("UPDATE accounts SET display_name = $1, avatar_url = $2 WHERE id = $3")
                .bind(u.display_name())
                .bind(u.avatar_url())
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE identities SET username = $1, updated_at = now() WHERE provider = 'discord' AND subject = $2")
                .bind(&u.username)
                .bind(&u.id)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            let id = Uuid::now_v7();
            sqlx::query("INSERT INTO accounts (id, display_name, avatar_url) VALUES ($1, $2, $3)")
                .bind(id)
                .bind(u.display_name())
                .bind(u.avatar_url())
                .execute(&mut *tx)
                .await?;
            let r = sqlx::query(
                "INSERT INTO identities (provider, subject, account_id, username) VALUES ('discord', $1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(&u.id)
            .bind(id)
            .bind(&u.username)
            .execute(&mut *tx)
            .await?;
            if r.rows_affected() == 0 {
                // Lost a race; dropping the transaction discards our account.
                return Ok(None);
            }
            id
        }
    };
    tx.commit().await?;
    Ok(Some(id))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: Uuid,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

async fn account(s: &AppState, id: Uuid) -> Result<Account> {
    let (display_name, avatar_url): (String, Option<String>) =
        sqlx::query_as("SELECT display_name, avatar_url FROM accounts WHERE id = $1").bind(id).fetch_one(&s.db).await?;
    Ok(Account { id, display_name, avatar_url })
}

#[derive(Serialize, Deserialize)]
pub struct AccessClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub exp: u64,
    pub iat: u64,
}

#[derive(Deserialize)]
pub struct TokenForm {
    grant_type: String,
    code: Option<String>,
    code_verifier: Option<String>,
    redirect_uri: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub refresh_token: String,
    pub account: Account,
}

fn verify_pkce(verifier: &str, challenge: &str) -> bool {
    (43..=128).contains(&verifier.len()) && B64.encode(Sha256::digest(verifier.as_bytes())) == challenge
}

pub async fn token(State(s): State<AppState>, Form(f): Form<TokenForm>) -> Result<Json<TokenResponse>> {
    let (account_id, family) = match f.grant_type.as_str() {
        "authorization_code" => {
            let code = f.code.as_deref().ok_or_else(|| bad("invalid_request", "code is required"))?;
            let row: Option<(Uuid, String, String)> = sqlx::query_as(
                "DELETE FROM auth_codes WHERE code_hash = $1 AND expires_at > now() RETURNING account_id, redirect_uri, code_challenge",
            )
            .bind(hash(code))
            .fetch_optional(&s.db)
            .await?;
            let Some((account, redirect_uri, challenge)) = row else {
                return Err(bad("invalid_grant", "the code is invalid or expired"));
            };
            if f.redirect_uri.as_deref() != Some(redirect_uri.as_str()) {
                return Err(bad("invalid_grant", "redirect_uri doesn't match"));
            }
            if !verify_pkce(f.code_verifier.as_deref().unwrap_or_default(), &challenge) {
                return Err(bad("invalid_grant", "code_verifier doesn't match"));
            }
            (account, Uuid::now_v7())
        }
        "refresh_token" => {
            let rt = f.refresh_token.as_deref().ok_or_else(|| bad("invalid_request", "refresh_token is required"))?;
            // Locks the row, so of two concurrent uses exactly one gets `was_rotated = false`.
            let row: Option<(Uuid, Uuid, bool)> = sqlx::query_as(
                "WITH old AS (SELECT token_hash, rotated FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now() FOR UPDATE)
                 UPDATE refresh_tokens r SET rotated = true FROM old WHERE r.token_hash = old.token_hash
                 RETURNING r.account_id, r.family, old.rotated",
            )
            .bind(hash(rt))
            .fetch_optional(&s.db)
            .await?;
            match row {
                Some((account, family, false)) => (account, family),
                Some((_, family, true)) => {
                    // A rotated token came back: someone else has a copy. End that sign-in.
                    tracing::warn!("refresh token reuse; revoking sign-in {family}");
                    sqlx::query("DELETE FROM refresh_tokens WHERE family = $1").bind(family).execute(&s.db).await?;
                    return Err(bad("invalid_grant", "this sign-in was revoked; sign in again"));
                }
                None => return Err(bad("invalid_grant", "the refresh token is invalid or expired")),
            }
        }
        _ => return Err(bad("unsupported_grant_type", "use authorization_code or refresh_token")),
    };

    let refresh_token = random_token();
    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, family, account_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    )
    .bind(hash(&refresh_token))
    .bind(family)
    .bind(account_id)
    .bind(REFRESH_TTL_DAYS)
    .execute(&s.db)
    .await?;

    let iat = now();
    let access_token = s.keys.sign(&AccessClaims {
        iss: s.config.public_url.clone(),
        aud: AUDIENCE.into(),
        sub: account_id.to_string(),
        iat,
        exp: iat + ACCESS_TTL_SECS,
    })?;
    Ok(Json(TokenResponse {
        access_token,
        token_type: "Bearer".into(),
        expires_in: ACCESS_TTL_SECS,
        refresh_token,
        account: account(&s, account_id).await?,
    }))
}

/// The account behind a `Bearer` access token.
pub async fn authed(s: &AppState, headers: &HeaderMap) -> Result<Uuid> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(Error::Unauthorized)?;
    let claims: AccessClaims = s.keys.verify(token, &s.config.public_url, AUDIENCE).ok_or(Error::Unauthorized)?;
    claims.sub.parse().map_err(|_| Error::Unauthorized)
}

pub async fn me(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Account>> {
    let id = authed(&s, &headers).await?;
    Ok(Json(account(&s, id).await?))
}

#[derive(Deserialize)]
pub struct LogoutForm {
    refresh_token: String,
}

/// Ends the sign-in a refresh token belongs to (every token in its family).
pub async fn logout(State(s): State<AppState>, Form(f): Form<LogoutForm>) -> Result<()> {
    sqlx::query("DELETE FROM refresh_tokens WHERE family = (SELECT family FROM refresh_tokens WHERE token_hash = $1)")
        .bind(hash(&f.refresh_token))
        .execute(&s.db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256() {
        // RFC 7636 appendix B.
        assert!(verify_pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!verify_pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!verify_pkce("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    }

    #[test]
    fn redirect_query() {
        assert_eq!(with_query("branchr://auth/callback", &[("code", "a b"), ("state", "s")]), "branchr://auth/callback?code=a+b&state=s");
        assert_eq!(with_query("http://localhost:5173/?x=1", &[("code", "c")]), "http://localhost:5173/?x=1&code=c");
    }
}
