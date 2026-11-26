//! RELAY=1: be reached through a relay, so this hub needs no domain, open ports or public
//! address. The hub dials out and is reachable at `<relay>/h/<its key>/`.
//!
//! On branchr, the owner picks which of their relays carries this hub; we ask every so often
//! (RELAY_POLL_SECS), connect to it with the pass branchr gives, and point the voice server
//! (SFU_PUBLIC_IP=relay) at it, so voice and video go through it too.
//!
//! An older branchr has one gateway for all hubs: voice and video then go to the hub directly
//! unless the gateway carries them (RELAY_SFU_UDP says where to deliver them).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use relay::agent::{Auth, Connect, PassFn, Targets};
use tokio::task::JoinHandle;

use crate::federation::{Federation, Linked, RelayAt, Ticket};
use crate::state::AppState;

/// Where a connector currently goes; it's restarted when this changes.
#[derive(PartialEq, Clone)]
struct Plan {
    relay: RelayAt,
    udp_base: u16,
    sfu_udp: SocketAddr,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SfuStatus {
    udp_port: u16,
    ports: Vec<u16>,
}

fn local_api(state: &AppState) -> String {
    format!("http://127.0.0.1:{}", state.config.bind.port())
}

/// The local voice server, over HTTP.
fn local_sfu(state: &AppState) -> String {
    state.config.sfu_urls.first().map(|u| u.replacen("ws", "http", 1).trim_end_matches("/ws").to_string()).unwrap_or_else(|| "http://127.0.0.1:8090".into())
}

/// Records where visitors reach us (or that they can't).
fn reachable_at(state: &AppState, url: Option<String>) {
    if *state.relayed.read() != url {
        match &url {
            Some(u) => tracing::info!("reachable at {u}"),
            None => tracing::info!("no longer relayed"),
        }
        *state.relayed.write() = url;
        state.discovery_changed.notify_one();
    }
}

fn connector(state: &AppState, relay: &RelayAt, pass: PassFn, sfu_udp: SocketAddr) -> impl Future<Output = ()> + Send + 'static {
    let web = relay.web.trim_end_matches('/').to_string();
    let on_welcome = {
        let state = state.clone();
        Arc::new(move |w: &relay::proto::Welcome| reachable_at(&state, Some(format!("{web}/h/{}", w.name))))
    };
    let targets = Targets { api: local_api(state), sfu: local_sfu(state), sfu_udp };
    let connect = Connect { relay: relay.quic.clone(), fp: relay.fp.clone(), auth: Auth::Pass(pass), on_welcome: Some(on_welcome) };
    async move {
        if let Err(e) = relay::agent::run(connect, targets).await {
            tracing::warn!("relay: {e:#}");
        }
    }
}

pub async fn run(state: AppState) {
    let Some(fed) = state.federation.clone() else {
        tracing::warn!("RELAY=1 needs a branchr ID (AUTH_MODE and BRANCHR_ID_URL)");
        return;
    };
    let poll = Duration::from_secs(std::env::var("RELAY_POLL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(60).max(1));
    let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client");
    let mut running: Option<(Plan, JoinHandle<()>)> = None;
    let mut told_direct = false;
    loop {
        // Registration and the voice server can both take a moment at startup.
        let mut wait = Duration::from_secs(5).min(poll);
        if fed.identity().is_some() {
            match round(&state, &fed, &http, &mut running, &mut told_direct).await {
                Ok(true) => wait = poll,
                Ok(false) => return shared_gateway(state, fed, http).await,
                // Out of reach: keep any connection we have.
                Err(e) => tracing::warn!("relay: {e:#}"),
            }
        }
        tokio::time::sleep(wait).await;
    }
}

/// Brings the connector and voice server in line with what branchr says. False for an older
/// branchr with a shared gateway.
async fn round(
    state: &AppState,
    fed: &Arc<Federation>,
    http: &reqwest::Client,
    running: &mut Option<(Plan, JoinHandle<()>)>,
    told_direct: &mut bool,
) -> anyhow::Result<bool> {
    let sfu = local_sfu(state);
    let status: SfuStatus = http.get(format!("{sfu}/status")).send().await?.error_for_status()?.json().await?;
    let Linked { relay, udp_base, .. } = match fed.relay_ticket(status.ports.len(), false).await? {
        Ticket::Linked(l) => l,
        Ticket::SharedGateway => return Ok(false),
        Ticket::Unlinked => {
            if let Some((_, task)) = running.take() {
                task.abort();
            }
            reachable_at(state, None);
            return Ok(true);
        }
    };
    let url = reqwest::Url::parse(&sfu)?;
    let host = url.host_str().ok_or_else(|| anyhow::anyhow!("SFU_URLS has no host"))?;
    let sfu_udp = tokio::net::lookup_host((host.trim_matches(['[', ']']), status.udp_port)).await?.next().ok_or_else(|| anyhow::anyhow!("can't resolve {host}"))?;
    // Every time, so a restarted voice server learns it again.
    let told = http
        .post(format!("{sfu}/relay"))
        .bearer_auth(String::from_utf8_lossy(&state.config.voice_secret))
        .json(&serde_json::json!({ "publicIp": relay.public_ip, "publicPort": udp_base }))
        .send()
        .await?;
    if told.status() == reqwest::StatusCode::CONFLICT {
        if !std::mem::replace(told_direct, true) {
            tracing::warn!("the voice server still hands out this hub's own address; set SFU_PUBLIC_IP=relay to send voice and video through the relay");
        }
    } else {
        told.error_for_status()?;
    }
    let plan = Plan { relay, udp_base, sfu_udp };
    if running.as_ref().is_none_or(|(p, task)| *p != plan || task.is_finished()) {
        if let Some((_, task)) = running.take() {
            task.abort();
            reachable_at(state, None);
        }
        let (fed, ports) = (fed.clone(), status.ports.len());
        let pass: PassFn = Arc::new(move || {
            let fed = fed.clone();
            Box::pin(async move {
                match fed.relay_ticket(ports, true).await? {
                    Ticket::Linked(l) if !l.token.is_empty() => Ok(l.token),
                    _ => anyhow::bail!("this hub isn't linked to a relay"),
                }
            })
        });
        let task = tokio::spawn(connector(state, &plan.relay, pass, plan.sfu_udp));
        *running = Some((plan, task));
    }
    Ok(true)
}

/// An older branchr: one gateway for every hub.
async fn shared_gateway(state: AppState, fed: Arc<Federation>, http: reqwest::Client) {
    #[derive(serde::Deserialize)]
    struct Info {
        quic: String,
        fp: String,
        web: String,
    }
    // Without RELAY_SFU_UDP, media the gateway sends is discarded (port 9).
    let sfu_udp = std::env::var("RELAY_SFU_UDP").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "127.0.0.1:9".into());
    let sfu_udp: SocketAddr = match sfu_udp.parse() {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("RELAY_SFU_UDP {sfu_udp:?} isn't an address and port: {e}");
            return;
        }
    };
    let info = loop {
        match http.get(format!("{}/relay", fed.id_url())).send().await {
            Ok(r) if r.status().is_success() => match r.json::<Info>().await {
                Ok(i) => break i,
                Err(e) => tracing::warn!("branchr's gateway: {e}"),
            },
            Ok(r) => tracing::warn!("branchr has no gateway for hubs ({})", r.status()),
            Err(e) => tracing::warn!("branchr's gateway: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    };
    let pass: PassFn = Arc::new(move || {
        let fed = fed.clone();
        Box::pin(async move { fed.relay_pass().await })
    });
    // The address only matters for visitors' media, which an older gateway may not carry.
    let relay = RelayAt { quic: info.quic, fp: info.fp, web: info.web, public_ip: [0, 0, 0, 0].into() };
    connector(&state, &relay, pass, sfu_udp).await;
}
