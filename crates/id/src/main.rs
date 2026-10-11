use id::config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let config = Config::from_env()?;
    // A separate schema keeps e.g. end-to-end test data apart from real accounts.
    let schema = std::env::var("DATABASE_SCHEMA").ok().filter(|s| !s.is_empty());
    let db = id::connect(&config.database_url, schema.as_deref()).await?;
    tokio::spawn(id::gc(db.clone()));
    let bind = config.bind;
    tracing::info!("branchr ID on {bind}, public at {}", config.public_url);
    let app = id::router(id::state(config, db).await?);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    axum::serve(listener, app).with_graceful_shutdown(async { tokio::signal::ctrl_c().await.ok(); }).await?;
    Ok(())
}
