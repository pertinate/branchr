//! The hosts (self-hosted instances) an account uses. A new device signs in once and the
//! app reconnects to all of them. Only addresses are kept, never anything from the hosts.

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::error::{Result, bad};
use crate::oauth::authed;

/// Per account, generously.
const MAX_HOSTS: i64 = 100;

#[derive(Serialize, Deserialize, Debug)]
pub struct Host {
    pub url: String,
}

/// `https://chat.example.com` style origins only (no paths, queries or credentials).
fn origin(url: &str) -> Result<String> {
    let u = url::Url::parse(url.trim()).map_err(|_| bad("invalid_request", "url must be a URL"))?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() || !u.username().is_empty() || u.password().is_some() {
        return Err(bad("invalid_request", "url must be an http(s) origin"));
    }
    Ok(u.origin().ascii_serialization())
}

pub async fn list(State(s): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<Host>>> {
    let account = authed(&s, &headers).await?;
    let rows: Vec<(String,)> = sqlx::query_as("SELECT url FROM account_instances WHERE account_id = $1 ORDER BY added_at")
        .bind(account)
        .fetch_all(&s.db)
        .await?;
    Ok(Json(rows.into_iter().map(|(url,)| Host { url }).collect()))
}

pub async fn add(State(s): State<AppState>, headers: HeaderMap, Json(h): Json<Host>) -> Result<()> {
    let account = authed(&s, &headers).await?;
    let url = origin(&h.url)?;
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM account_instances WHERE account_id = $1").bind(account).fetch_one(&s.db).await?;
    if count >= MAX_HOSTS {
        return Err(bad("invalid_request", "too many hosts"));
    }
    sqlx::query("INSERT INTO account_instances (account_id, url) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(account)
        .bind(url)
        .execute(&s.db)
        .await?;
    Ok(())
}

pub async fn remove(State(s): State<AppState>, headers: HeaderMap, Json(h): Json<Host>) -> Result<()> {
    let account = authed(&s, &headers).await?;
    sqlx::query("DELETE FROM account_instances WHERE account_id = $1 AND url = $2")
        .bind(account)
        .bind(origin(&h.url)?)
        .execute(&s.db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert_eq!(origin("https://Chat.Example.com/").unwrap(), "https://chat.example.com");
        assert_eq!(origin("http://localhost:8081/#/invite/x").unwrap(), "http://localhost:8081");
        assert!(origin("ftp://x").is_err());
        assert!(origin("https://user:pw@x.com").is_err());
        assert!(origin("not a url").is_err());
    }
}
