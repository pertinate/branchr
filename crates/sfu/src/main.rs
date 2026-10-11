//! Selective forwarding unit for voice, video and screen/game streaming.
//!
//! Media is never decoded or transcoded: incoming frames are forwarded to subscribers
//! as reference-counted buffers, so CPU cost is independent of stream resolution and
//! the only practical limits are the publisher's encoder and the viewers' bandwidth.

mod config;
mod h264;
mod shared;
mod udp;
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
    let (txs, rxs): (Vec<_>, Vec<_>) = (0..config.workers).map(|_| tokio::sync::mpsc::unbounded_channel()).unzip();
    let shared = Arc::new(shared::Shared::new(txs));
    for (i, rx) in rxs.into_iter().enumerate() {
        worker::spawn(i, &config, shared.clone(), rx)?;
    }
    tracing::info!(
        workers = config.workers,
        udp = %format!("{}-{}", config.udp_port, config.udp_port as usize + config.workers - 1),
        public_ip = %config.public_ip,
        "sfu started"
    );

    let app = Arc::new(signaling::App::new(config.clone(), shared));
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    tracing::info!("signaling listening on {}", config.bind);
    axum::serve(listener, signaling::router(app)).await?;
    Ok(())
}
