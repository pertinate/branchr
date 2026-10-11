//! branchr ID: the central account service. Clients sign in with Discord; instances verify
//! the tokens it issues against its published keys.

pub mod config;
pub mod discord;
pub mod error;
pub mod hosts;
pub mod instances;
pub mod keys;
pub mod oauth;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::{get, post};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{Any, CorsLayer};

use crate::config::Config;
use crate::keys::Keys;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub keys: Arc<Keys>,
    pub http: reqwest::Client,
}

/// Connects and migrates. `schema` (tests) keeps everything in its own Postgres schema.
pub async fn connect(url: &str, schema: Option<&str>) -> anyhow::Result<PgPool> {
    let mut opts = PgPoolOptions::new().max_connections(16).acquire_timeout(Duration::from_secs(10));
    if let Some(schema) = schema {
        anyhow::ensure!(schema.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "bad schema name");
        let set = format!("SET search_path TO {schema}");
        opts = opts.after_connect(move |conn, _| {
            let set = set.clone();
            Box::pin(async move {
                sqlx::query(sqlx::AssertSqlSafe(set)).execute(conn).await?;
                Ok(())
            })
        });
        let admin = PgPoolOptions::new().max_connections(1).connect(url).await?;
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA IF NOT EXISTS {schema}"))).execute(&admin).await?;
        admin.close().await;
    }
    let db = opts.connect(url).await?;
    sqlx::migrate!("./migrations").run(&db).await?;
    Ok(db)
}

pub async fn state(config: Config, db: PgPool) -> anyhow::Result<AppState> {
    let keys = Keys::load(&db).await?;
    let http = reqwest::Client::builder().user_agent(discord::USER_AGENT).timeout(Duration::from_secs(10)).build()?;
    Ok(AppState { config: Arc::new(config), db, keys: Arc::new(keys), http })
}

pub fn router(state: AppState) -> Router {
    // Bearer tokens only, no cookies, so any origin may call (instances serve the web client).
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    Router::new()
        .route("/authorize", get(oauth::authorize))
        .route("/auth/discord/callback", get(oauth::discord_callback))
        .route("/token", post(oauth::token))
        .route("/logout", post(oauth::logout))
        .route("/me", get(oauth::me))
        .route("/me/instances", get(hosts::list).put(hosts::add).delete(hosts::remove))
        .route("/instances", post(instances::register))
        .route("/instances/{id}", get(instances::status))
        .route("/instances/{id}/claim-code", post(instances::new_claim_code))
        .route("/instances/{id}/token", post(instances::token))
        .route("/claims", post(instances::claim))
        .route("/.well-known/jwks.json", get(|s: axum::extract::State<AppState>| async move { axum::Json(s.keys.jwks()) }))
        .route("/health", get(|| async { "ok" }))
        .layer(cors)
        .with_state(state)
}

/// Deletes expired sign-in state now and then.
pub async fn gc(db: PgPool) {
    let mut tick = tokio::time::interval(Duration::from_secs(600));
    loop {
        tick.tick().await;
        for q in [
            "DELETE FROM auth_requests WHERE created_at < now() - interval '1 hour'",
            "DELETE FROM auth_codes WHERE expires_at < now()",
            "DELETE FROM refresh_tokens WHERE expires_at < now()",
        ] {
            if let Err(e) = sqlx::query(q).execute(&db).await {
                tracing::warn!("gc: {e}");
            }
        }
    }
}
