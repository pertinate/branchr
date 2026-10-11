mod auth;
mod config;
mod db;
mod emote_providers;
mod error;
mod gateway;
mod hub;
mod ratelimit;
mod routes;
mod state;

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, patch, post, put};
use dashmap::DashMap;
use proto::id::IdGen;
use tower_http::compression::CompressionLayer;
use axum::http::HeaderValue;
use axum::http::header::CACHE_CONTROL;
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::routes::{attachments, channels, emotes, guilds, messages, users};
use crate::state::{AppState, State};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("api=info,tower_http=warn")))
        .init();

    raise_nofile_limit();
    let config = Config::from_env()?;
    let db = db::connect(&config.database_url).await?;
    let worker = std::env::var("WORKER_ID").ok().and_then(|w| w.parse().ok()).unwrap_or(0);

    let state: AppState = Arc::new(State {
        db,
        hub: Default::default(),
        ids: IdGen::new(worker),
        emotes: emote_providers::EmoteProviders::new(),
        sessions: DashMap::new(),
        channel_guild: DashMap::new(),
        message_limiter: ratelimit::RateLimiter::new(10, 5.0),
        config: config.clone(),
    });

    let api = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/users/@me", get(users::me).patch(users::patch_me))
        .route("/guilds", post(guilds::create))
        .route("/guilds/{gid}", patch(guilds::patch).delete(guilds::delete))
        .route("/guilds/{gid}/members/@me", delete(guilds::leave).patch(guilds::patch_me_member))
        .route("/guilds/{gid}/members/{uid}", delete(guilds::kick))
        .route("/guilds/{gid}/channels", post(channels::create))
        .route("/guilds/{gid}/invites", post(guilds::create_invite))
        .route("/guilds/{gid}/emotes", post(emotes::add))
        .route("/guilds/{gid}/emotes/import", post(emotes::import_set))
        .route("/guilds/{gid}/emotes/{eid}", patch(emotes::rename).delete(emotes::remove))
        .route("/invites/{code}", get(guilds::get_invite).post(guilds::accept_invite))
        .route("/channels/{cid}", patch(channels::patch).delete(channels::delete))
        .route("/channels/{cid}/messages", get(messages::list).post(messages::create))
        .route("/channels/{cid}/messages/{mid}", patch(messages::edit).delete(messages::delete))
        .route("/channels/{cid}/messages/{mid}/reactions/{emoji}", put(messages::react).delete(messages::unreact))
        .route("/emotes/search", get(emotes::search))
        .route("/emotes/lookup", get(emotes::lookup))
        .route("/channels/{cid}/attachments", post(attachments::upload))
        .route("/attachments/{id}/{token}/{name}", get(attachments::serve))
        .route("/health", get(|| async { "ok" }));

    tokio::spawn(attachments::gc(state.clone()));

    let mut app = Router::new().nest("/api", api).route("/gateway", get(gateway::upgrade));

    if let Some(dir) = &config.web_dir {
        // Hashed assets never change: cache them forever. index.html is the SPA fallback.
        let assets = Router::new().fallback_service(ServeDir::new(dir.join("assets"))).layer(
            SetResponseHeaderLayer::overriding(CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")),
        );
        let index = dir.join("index.html");
        app = app
            .nest("/assets", assets)
            .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }

    // Layers last so they also wrap the static file services.
    let app = app.layer(CompressionLayer::new()).layer(CorsLayer::permissive()).with_state(state);

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!("api listening on {}", config.bind);
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    ctrl_c.await.ok();
}

/// Raise the open-file soft limit to the hard limit: every WebSocket/connection is a file
/// descriptor, and container defaults (1024) cap a server at ~1000 users.
fn raise_nofile_limit() {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: plain syscalls with a valid out-pointer.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 && lim.rlim_cur < lim.rlim_max {
            let before = lim.rlim_cur;
            lim.rlim_cur = lim.rlim_max;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) == 0 {
                tracing::info!("raised open file limit {before} -> {}", lim.rlim_cur);
            }
        }
    }
}
