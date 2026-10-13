mod audit;
mod auth;
mod config;
mod db;
mod discovery;
mod emote_providers;
mod error;
mod federation;
mod gateway;
mod hub;
mod mentions;
mod migrate_db;
mod perms;
mod routes;
mod state;
mod storage;
mod relaying;
mod thumbs;
mod unfurl;

use std::sync::Arc;

use axum::Router;
use axum::response::Redirect;
use axum::extract::DefaultBodyLimit;
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
use crate::routes::{admin, attachments, bans, channels, emotes, guilds, messages, pictures, roles, search, users, webhooks};
use crate::state::{AppState, State};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("api=info,tower_http=warn")))
        .init();

    raise_nofile_limit();
    // `api migrate-db --from sqlite://… --to postgres://…` (before reading the usual config).
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("migrate-db") {
        let arg = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
        let (Some(from), Some(to)) = (arg("--from"), arg("--to")) else { anyhow::bail!("usage: api migrate-db --from sqlite://… --to postgres://…") };
        return migrate_db::run(&from, &to).await;
    }
    let config = Config::from_env()?;
    let db = db::connect(&config.database_url).await?;
    let storage = storage::Storage::new(&config.storage)?;
    if std::env::args().nth(1).as_deref() == Some("migrate-storage") {
        return storage::migrate(&storage).await;
    }
    // Object storage may still be starting next to us (compose): give it a minute.
    for attempt in 1.. {
        match storage.init().await {
            Ok(()) => break,
            Err(e) if attempt < 30 => {
                tracing::warn!("storage not ready ({e:#}), retrying");
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e),
        }
    }
    tracing::info!("files stored in {}", storage.describe());
    let worker = std::env::var("WORKER_ID").ok().and_then(|w| w.parse().ok()).unwrap_or(0);

    let state: AppState = Arc::new(State {
        db,
        storage,
        hub: Default::default(),
        perms: Default::default(),
        discovery_changed: Default::default(),
        ids: IdGen::new(worker),
        emotes: emote_providers::EmoteProviders::new(),
        sessions: DashMap::new(),
        channel_guild: DashMap::new(),
        message_limiter: throttle::Buckets::new(10, 5.0),
        webhook_limiter: throttle::Buckets::new(5, 2.0),
        slowmode: DashMap::new(),
        last_sent: DashMap::new(),
        // LINK_PREVIEWS=0 turns link previews off; EMBED_ALLOW_PRIVATE (tests only) lets them reach localhost.
        unfurl: (std::env::var("LINK_PREVIEWS").as_deref() != Ok("0"))
            .then(|| unfurl::Unfurler::new(std::env::var("EMBED_ALLOW_PRIVATE").as_deref() == Ok("1"))),
        open_registration: std::sync::atomic::AtomicBool::new(config.open_registration),
        max_upload_bytes: std::sync::atomic::AtomicU64::new(config.max_upload_bytes),
        relayed: Default::default(),
        federation: (config.auth_mode != config::AuthMode::Local).then(|| Arc::new(federation::Federation::new(&config))),
        config: config.clone(),
    });
    admin::load_settings(&state).await?;
    if let Some(fed) = state.federation.clone() {
        tokio::spawn({
            let (db, config) = (state.db.clone(), config.clone());
            async move { fed.run(db, config).await }
        });
    }

    // Per client address: password guessing and account spam, and invite code guessing.
    let trust_proxy = throttle::trust_proxy_from_env();
    let sign_in = Router::new()
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/federated", post(auth::federated))
        .layer(axum::middleware::from_fn_with_state(throttle::IpLimit::new(10, 60.0, trust_proxy), throttle::ip_limit));
    let invites = Router::new()
        .route("/invites/{code}", get(guilds::get_invite).post(guilds::accept_invite))
        .layer(axum::middleware::from_fn_with_state(throttle::IpLimit::new(30, 60.0, trust_proxy), throttle::ip_limit));
    let api = Router::new()
        .merge(sign_in)
        .merge(invites)
        .route("/auth/logout", post(auth::logout))
        .route("/guilds/{gid}/webhooks", get(webhooks::list))
        .route("/messages/search", get(search::search_everywhere))
        .route("/channels/{cid}/webhooks", post(webhooks::create))
        .route("/channels/{cid}/threads", post(channels::create_thread))
        .route("/webhooks/{wid}", patch(webhooks::patch).delete(webhooks::delete))
        .route("/webhooks/{wid}/{token}", post(webhooks::execute))
        .route("/auth/link", get(auth::link_status).post(auth::link))
        .route("/instance", get(auth::instance_info))
        .route("/admin/overview", get(admin::overview))
        .route("/admin/settings", patch(admin::settings))
        .route("/admin/users", get(admin::users))
        .route("/admin/bans/{uid}", put(admin::ban).delete(admin::unban))
        .route("/admin/staff/{uid}", put(admin::set_staff))
        .route("/admin/guilds", get(admin::guilds))
        .route("/admin/guilds/{gid}", delete(admin::delete_guild))
        .route("/users/@me", get(users::me).patch(users::patch_me))
        .route("/users/{uid}/profile", get(users::profile))
        .route("/users/@me/avatar", put(pictures::put_avatar).delete(pictures::delete_avatar).layer(DefaultBodyLimit::max(pictures::MAX_BYTES)))
        .route("/guilds/{gid}/icon", put(pictures::put_icon).delete(pictures::delete_icon).layer(DefaultBodyLimit::max(pictures::MAX_BYTES)))
        .route("/guilds/{gid}/banner", put(pictures::put_banner).delete(pictures::delete_banner).layer(DefaultBodyLimit::max(pictures::MAX_BYTES)))
        .route("/files/{*key}", get(pictures::serve))
        .route("/guilds", post(guilds::create))
        .route("/guilds/{gid}", patch(guilds::patch).delete(guilds::delete))
        .route("/guilds/{gid}/members/@me", delete(guilds::leave).patch(guilds::patch_me_member))
        .route("/guilds/{gid}/members/{uid}", delete(guilds::kick))
        .route("/guilds/{gid}/bans", get(bans::list))
        .route("/guilds/{gid}/bans/{uid}", put(bans::ban).delete(bans::unban))
        .route("/guilds/{gid}/audit-log", get(bans::audit_log))
        .route("/guilds/{gid}/members/{uid}/roles/{rid}", put(roles::add_member_role).delete(roles::remove_member_role))
        .route("/guilds/{gid}/roles", post(roles::create).patch(roles::reorder))
        .route("/guilds/{gid}/roles/{rid}", patch(roles::update).delete(roles::delete))
        .route("/guilds/{gid}/channels", post(channels::create).patch(channels::reorder))
        .route("/guilds/{gid}/invites", post(guilds::create_invite))
        .route("/guilds/{gid}/emotes", post(emotes::add))
        .route("/guilds/{gid}/emotes/import", post(emotes::import_set))
        .route("/guilds/{gid}/emotes/{eid}", patch(emotes::rename).delete(emotes::remove))
        .route("/channels/{cid}", patch(channels::patch).delete(channels::delete))
        .route("/channels/{cid}/permissions/{target}", put(channels::put_overwrite))
        .route("/channels/{cid}/permissions/{kind}/{target}", delete(channels::delete_overwrite))
        .route("/channels/{cid}/messages", get(messages::list).post(messages::create))
        .route("/channels/{cid}/messages/{mid}", patch(messages::edit).delete(messages::delete))
        .route("/channels/{cid}/pins", get(search::pins))
        .route("/channels/{cid}/pins/{mid}", put(search::pin).delete(search::unpin))
        .route("/guilds/{gid}/messages/search", get(search::search))
        .route("/channels/{cid}/messages/{mid}/reactions/{emoji}", put(messages::react).delete(messages::unreact))
        .route("/channels/{cid}/messages/{mid}/poll/{answer}", put(messages::vote).delete(messages::unvote))
        .route("/emotes/search", get(emotes::search))
        .route("/emotes/lookup", get(emotes::lookup))
        .route("/channels/{cid}/attachments", post(attachments::upload))
        .route("/attachments/{id}/{token}/{name}", get(attachments::serve))
        .route("/attachments/{id}/{token}/thumb/{name}", get(attachments::serve_thumb))
        .route("/health", get(|| async { "ok" }));

    tokio::spawn(attachments::gc(state.clone()));
    tokio::spawn(audit::trim(state.clone()));
    tokio::spawn(discovery::run(state.clone()));
    if config.relay {
        tokio::spawn(relaying::run(state.clone()));
    }

    let mut app = Router::new().nest("/api", api).route("/gateway", get(gateway::upgrade));

    // The app at /app/, the product site (SITE_DIR) at /; without a site, / leads to the app.
    if let Some(dir) = &config.web_dir {
        app = app.nest_service("/app", static_site(dir)).layer(axum::middleware::from_fn(app_slash));
        if config.site_dir.is_none() {
            // Relative, so it stays under a gateway's /h/<name>/ prefix.
            app = app.route("/", get(|| async { Redirect::temporary("app/") }));
        }
    }
    if let Some(dir) = &config.site_dir {
        app = app.fallback_service(static_site(dir));
    }

    // Layers last so they also wrap the static file services.
    let app = app.layer(CompressionLayer::new()).layer(CorsLayer::permissive()).with_state(state);

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!("api listening on {}", config.bind);
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

/// A built Vite site: hashed assets cached forever, anything else falls back to index.html.
fn static_site(dir: &std::path::Path) -> Router {
    let assets = Router::new().fallback_service(ServeDir::new(dir.join("assets"))).layer(
        SetResponseHeaderLayer::overriding(CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")),
    );
    Router::new().nest("/assets", assets).fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))))
}

/// `/app` → `/app/`, so the app's relative asset paths resolve under it.
async fn app_slash(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    if req.uri().path() == "/app" {
        let q = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
        // Relative ("app/" from ".../app"), so it stays under a gateway's /h/<name>/ prefix.
        return axum::response::IntoResponse::into_response(Redirect::permanent(&format!("app/{q}")));
    }
    next.run(req).await
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
