//! Selective forwarding unit for voice, video and screen/game streaming.
//!
//! Media is never decoded or transcoded: incoming frames are forwarded to subscribers
//! as reference-counted buffers, so CPU cost is independent of stream resolution and
//! the only practical limits are the publisher's encoder and the viewers' bandwidth.

mod config;
mod h264;
mod signaling;
mod worker;

use std::sync::Arc;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("sfu=info")))
        .init();
    str0m::crypto::from_feature_flags().install_process_default();
    // A panicking worker takes its rooms down; make sure that's loud in the logs.
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        tracing::error!(thread = thread.name().unwrap_or("?"), "panic: {info}");
    }));

    let config = config::Config::from_env()?;
    let mut workers = Vec::with_capacity(config.workers);
    for i in 0..config.workers {
        workers.push(worker::spawn(i, &config)?);
    }
    tracing::info!(
        workers = config.workers,
        udp = %format!("{}-{}", config.udp_port, config.udp_port as usize + config.workers - 1),
        public_ip = %config.public_ip,
        "sfu started"
    );

    let app = Arc::new(signaling::App::new(config.clone(), workers));
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!("signaling listening on {}", config.bind);
    axum::serve(listener, signaling::router(app)).await?;
    Ok(())
}
