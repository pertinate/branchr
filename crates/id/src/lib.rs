//! branchr ID: the central account service. Clients sign in with Discord; instances verify
//! the tokens it issues against its published keys.

pub mod calls;
pub mod config;
pub mod discovery;
pub mod discord;
pub mod error;
pub mod gateway;
pub mod hosts;
pub mod hub;
pub mod instances;
pub mod keys;
pub mod oauth;
pub mod social;

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
    pub hub: Arc<hub::Hub>,
    pub calls: Arc<calls::Calls>,
    /// Snowflakes for DM channels and messages.
    pub ids: Arc<proto::id::IdGen>,
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
    let worker = std::env::var("WORKER_ID").ok().and_then(|w| w.parse().ok()).unwrap_or(0);
    Ok(AppState { config: Arc::new(config), db, keys: Arc::new(keys), http, hub: Default::default(), calls: Default::default(), ids: Arc::new(proto::id::IdGen::new(worker)) })
}

pub fn router(state: AppState) -> Router {
    // Bearer tokens only, no cookies, so any origin may call (instances serve the web client).
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);
    // Per client address, on what anyone can call without an account: sign-in, host
    // registration and claiming, and Explore.
    let trust_proxy = throttle::trust_proxy_from_env();
    let open = Router::new()
        .route("/authorize", get(oauth::authorize))
        .route("/auth/discord/callback", get(oauth::discord_callback))
        .route("/token", post(oauth::token))
        .route("/instances", post(instances::register))
        .route("/instances/{id}/claim-code", post(instances::new_claim_code))
        .route("/instances/{id}/token", post(instances::token))
        .route("/claims", post(instances::claim))
        .layer(axum::middleware::from_fn_with_state(throttle::IpLimit::new(30, 60.0, trust_proxy), throttle::ip_limit));
    let explore = Router::new()
        .route("/discover", get(discovery::search))
        .layer(axum::middleware::from_fn_with_state(throttle::IpLimit::new(60, 60.0, trust_proxy), throttle::ip_limit));
    let router = Router::new()
        .merge(open)
        .merge(explore)
        .route("/logout", post(oauth::logout))
        .route("/me", get(oauth::me))
        .route("/me/instances", get(hosts::list).put(hosts::add).delete(hosts::remove))
        .route("/me/owned", get(instances::owned))
        .route("/people/@me", get(social::me))
        .route("/relationships", get(social::list).post(social::add))
        .route("/relationships/{id}", axum::routing::put(social::put).delete(social::remove))
        .route("/dms", get(social::dms).post(social::open))
        .route("/dms/groups", post(social::create_group))
        .route("/dms/{cid}/call", post(calls::join))
        .route("/dms/{cid}/call/leave", post(calls::leave))
        .route("/dms/{cid}/call/decline", post(calls::decline))
        .route("/dms/{cid}", axum::routing::patch(social::patch_group))
        .route("/dms/{cid}/recipients/{id}", axum::routing::put(social::add_member).delete(social::remove_member))
        .route("/dms/{cid}/messages", get(social::messages).post(social::send))
        .route("/dms/{cid}/messages/{mid}", axum::routing::patch(social::edit).delete(social::delete))
        .route("/gateway", get(gateway::upgrade))
        .route("/instances/{id}", get(instances::status))
        .route("/instances/{id}/claim", axum::routing::delete(instances::release))
        .route("/instances/{id}/transfer", post(instances::transfer))
        .route("/instances/{id}/listings", axum::routing::put(discovery::publish))
        .route("/.well-known/jwks.json", get(|s: axum::extract::State<AppState>| async move { axum::Json(s.keys.jwks()) }))
        .route("/health", get(|| async { "ok" }))
        .layer(cors);
    with_pages(router).with_state(state)
}

/// Where branchr ID is also the public front door (branchr.us): the product site at `/`
/// (SITE_DIR) and the app at `/app/` (WEB_DIR), which opens DEFAULT_HUB unless told otherwise.
fn with_pages(mut router: Router<AppState>) -> Router<AppState> {
    use tower_http::services::{ServeDir, ServeFile};
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if let Some(web) = var("WEB_DIR") {
        let hub = var("DEFAULT_HUB").unwrap_or_default();
        let config = format!("window.__BRANCHR__ = {};\n", serde_json::json!({ "defaultHub": hub }));
        let web = std::path::PathBuf::from(web);
        router = router
            .route(
                "/app/config.js",
                get(move || {
                    let config = config.clone();
                    async move { ([(axum::http::header::CONTENT_TYPE, "text/javascript"), (axum::http::header::CACHE_CONTROL, "no-cache")], config) }
                }),
            )
            .nest_service("/app", ServeDir::new(&web).fallback(ServeFile::new(web.join("index.html"))))
            .layer(axum::middleware::from_fn(app_slash));
    }
    if let Some(site) = var("SITE_DIR") {
        let site = std::path::PathBuf::from(site);
        router = router.fallback_service(ServeDir::new(&site).fallback(ServeFile::new(site.join("index.html"))));
    }
    router
}

/// `/app` → `app/`, so the app's relative asset paths resolve under it.
async fn app_slash(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    if req.uri().path() == "/app" {
        return axum::response::IntoResponse::into_response(axum::response::Redirect::permanent("app/"));
    }
    next.run(req).await
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
