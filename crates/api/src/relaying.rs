//! RELAY=1: be reached through branchr ID's gateway, like a Plex server through plex.tv. The
//! hub dials out (no domain or open web ports), proves who it is with a pass from branchr ID,
//! and is reachable at `https://<branchr ID>/h/<its key>/`. Voice and video still go to the
//! hub directly (see the sfu's SFU_PUBLIC_IP=auto).

use std::sync::Arc;
use std::time::Duration;

use relay::agent::{Auth, Connect, Targets};

use crate::state::AppState;

#[derive(serde::Deserialize)]
struct RelayInfo {
    quic: String,
    fp: String,
    /// Where visitors reach relayed hubs.
    web: String,
}

pub async fn run(state: AppState) {
    let Some(fed) = state.federation.clone() else {
        tracing::warn!("RELAY=1 needs a branchr ID (AUTH_MODE and BRANCHR_ID_URL)");
        return;
    };
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client");
    // Registered, and the gateway's address known: both can take a moment.
    let info = loop {
        if fed.identity().is_some() {
            match http.get(format!("{}/relay", fed.id_url())).send().await {
                Ok(r) if r.status().is_success() => match r.json::<RelayInfo>().await {
                    Ok(i) => break i,
                    Err(e) => tracing::warn!("branchr's gateway: {e}"),
                },
                Ok(r) => tracing::warn!("branchr has no gateway for hubs ({})", r.status()),
                Err(e) => tracing::warn!("branchr's gateway: {e}"),
            }
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    };
    let pass = {
        let fed = fed.clone();
        Arc::new(move || {
            let fed = fed.clone();
            Box::pin(async move { fed.relay_pass().await }) as std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>>
        })
    };
    let web = info.web.trim_end_matches('/').to_string();
    let on_welcome = {
        let state = state.clone();
        Arc::new(move |w: &relay::proto::Welcome| {
            let url = format!("{web}/h/{}", w.name);
            if state.relayed.read().as_deref() != Some(url.as_str()) {
                tracing::info!("reachable at {url}");
                *state.relayed.write() = Some(url);
                state.discovery_changed.notify_one();
            }
        })
    };
    // The local api and voice server, which the gateway's visitors reach through us.
    let api = format!("http://127.0.0.1:{}", state.config.bind.port());
    let sfu = state.config.sfu_urls.first().map(|u| u.replacen("ws", "http", 1).trim_end_matches("/ws").to_string()).unwrap_or_else(|| "http://127.0.0.1:8090".into());
    let targets = Targets { api, sfu, sfu_udp: "127.0.0.1:9".parse().expect("addr") };
    let connect = Connect { relay: info.quic, fp: info.fp, auth: Auth::Pass(pass), on_welcome: Some(on_welcome) };
    if let Err(e) = relay::agent::run(connect, targets).await {
        tracing::warn!("relay: {e:#}");
    }
}
