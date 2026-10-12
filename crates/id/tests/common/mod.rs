//! Shared test harness: a real Postgres (TEST_DATABASE_URL, own schema) and a stand-in Discord.

#![allow(dead_code, unused_imports)]

use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::{Form, Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use id::config::Config;
pub use id::oauth::{Account, TokenResponse};
pub use jsonwebtoken::{Algorithm, DecodingKey, Validation};
pub use reqwest::StatusCode;
use reqwest::redirect::Policy;
use sha2::{Digest, Sha256};

pub const REDIRECT: &str = "branchr://auth/callback";
pub const VERIFIER: &str = "a-pkce-verifier-that-is-long-enough-for-rfc-7636-0123456789";

pub async fn serve(app: Router) -> SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    addr
}

/// Discord's token and user endpoints. Code `good` belongs to user 42 (nelly), `bob` to 43.
pub fn fake_discord() -> Router {
    #[derive(serde::Deserialize)]
    struct F {
        code: String,
        grant_type: String,
    }
    Router::new()
        .route(
            "/oauth2/token",
            post(|Form(f): Form<F>| async move {
                assert_eq!(f.grant_type, "authorization_code");
                match f.code.as_str() {
                    "good" => Ok(Json(serde_json::json!({ "access_token": "discord-at-42", "token_type": "Bearer" }))),
                    "bob" => Ok(Json(serde_json::json!({ "access_token": "discord-at-43", "token_type": "Bearer" }))),
                    _ => Err(StatusCode::BAD_REQUEST),
                }
            }),
        )
        .route(
            "/users/@me",
            get(|h: axum::http::HeaderMap| async move {
                if h.get("authorization").is_some_and(|v| v.as_bytes().ends_with(b"-43")) {
                    Json(serde_json::json!({ "id": "43", "username": "bob", "global_name": "Bob", "avatar": null }))
                } else {
                    Json(serde_json::json!({ "id": "42", "username": "nelly", "global_name": "Nelly", "avatar": null }))
                }
            }),
        )
}

pub struct Harness {
    pub base: String,
    pub http: reqwest::Client,
    pub db: sqlx::PgPool,
    pub schema: String,
}

impl Harness {
    pub async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        sweep(&url).await;
        let schema = format!("idtest_{}", uuid::Uuid::now_v7().simple());
        let db = id::connect(&url, Some(&schema)).await.expect("database");
        let discord = serve(fake_discord()).await;
        // Bind first so the public URL (token issuer, Discord redirect) is known.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let config = Config {
            bind: l.local_addr().unwrap(),
            public_url: base.clone(),
            database_url: url,
            discord_client_id: "client".into(),
            discord_client_secret: "secret".into(),
            discord_api: format!("http://{discord}"),
            discord_authorize: "https://discord.example/oauth2/authorize".into(),
            redirects: vec![REDIRECT.into()],
        };
        let app = id::router(id::state(config, db.clone()).await.unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let http = reqwest::Client::builder().redirect(Policy::none()).build().unwrap();
        Some(Self { base, http, db, schema })
    }

    pub fn challenge(verifier: &str) -> String {
        B64.encode(Sha256::digest(verifier.as_bytes()))
    }

    /// /authorize → (Discord) → callback with Discord's `code`; returns where we were sent.
    pub async fn sign_in(&self, discord_code: &str) -> url::Url {
        let r = self
            .http
            .get(format!("{}/authorize", self.base))
            .query(&[
                ("redirect_uri", REDIRECT),
                ("code_challenge", &Self::challenge(VERIFIER)),
                ("code_challenge_method", "S256"),
                ("state", "client-state"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::SEE_OTHER, "{}", r.text().await.unwrap());
        let to_discord = url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap();
        assert!(to_discord.as_str().starts_with("https://discord.example/oauth2/authorize?"));
        let q: std::collections::HashMap<_, _> = to_discord.query_pairs().into_owned().collect();
        assert_eq!(q["scope"], "identify", "identify only");
        assert_eq!(q["redirect_uri"], format!("{}/auth/discord/callback", self.base));

        let r = self
            .http
            .get(format!("{}/auth/discord/callback", self.base))
            .query(&[("code", discord_code), ("state", &q["state"])])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::SEE_OTHER);
        url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap()
    }

    pub async fn token(&self, form: &[(&str, &str)]) -> reqwest::Response {
        self.http.post(format!("{}/token", self.base)).form(form).send().await.unwrap()
    }
}

impl Harness {
    pub async fn finish(self) {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {} CASCADE", self.schema))).execute(&self.db).await.unwrap();
        self.db.close().await;
    }
}

/// Drops test schemas left by failed runs over an hour ago (their names carry a UUIDv7 time).
async fn sweep(url: &str) {
    let db = sqlx::PgPool::connect(url).await.expect("database");
    let names: Vec<(String,)> = sqlx::query_as("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'idtest\\_%'").fetch_all(&db).await.unwrap();
    let hour_ago = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs().saturating_sub(3600);
    for (name,) in names {
        let old = uuid::Uuid::parse_str(&name["idtest_".len()..])
            .ok()
            .and_then(|u| u.get_timestamp())
            .is_some_and(|t| t.to_unix().0 < hour_ago);
        if old {
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {name} CASCADE"))).execute(&db).await;
        }
    }
    db.close().await;
}

pub fn param(u: &url::Url, k: &str) -> Option<String> {
    u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
}

impl Harness {
    /// An access token for the fake Discord user behind `code` (`good` or `bob`).
    pub async fn token_for(&self, code: &str) -> String {
        let back = param(&self.sign_in(code).await, "code").unwrap();
        let t: TokenResponse = self
            .token(&[("grant_type", "authorization_code"), ("code", &back), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)])
            .await
            .json()
            .await
            .unwrap();
        t.access_token
    }
}

