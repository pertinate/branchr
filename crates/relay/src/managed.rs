//! A relay managed through branchr: it registers, its owner claims it, and it carries the
//! hubs they link to it, on the ports branchr assigned. A hub shows a short-lived pass naming
//! this relay; a heartbeat tells us which hubs are still linked.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Claim codes last 24 hours; ask for another a little before.
const CLAIM_REFRESH: Duration = Duration::from_secs(23 * 3600);

/// What we tell branchr about ourselves.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    /// Where hubs connect (QUIC), `host:port`.
    pub quic: String,
    /// sha256 of our certificate.
    pub fp: String,
    /// Where visitors reach relayed hubs (`<web>/h/<key>`).
    pub web: String,
    /// Where voice clients send media; branchr uses the address it hears from if unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_ip: Option<String>,
    pub udp_start: u16,
    pub udp_end: u16,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// Which branchr this is registered with.
    url: String,
    pub relay_id: String,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registered {
    relay_id: String,
    secret: String,
    claim_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat {
    owner_id: Option<String>,
    hubs: Vec<Linked>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Linked {
    id: String,
    udp_base: u16,
    udp_ports: u16,
}

/// What branchr last said: who owns us, and each linked hub's ports.
#[derive(Default, Clone)]
pub struct Allowed {
    pub owner: Option<String>,
    pub hubs: HashMap<String, (u16, u16)>,
}

pub struct Managed {
    id_url: String,
    about: About,
    dir: PathBuf,
    name: String,
    http: reqwest::Client,
    identity: Mutex<Option<Identity>>,
    allowed: Mutex<Allowed>,
    claim_issued: Mutex<Option<Instant>>,
    /// One heartbeat at a time; when the last one was.
    beating: tokio::sync::Mutex<Option<Instant>>,
}

impl Managed {
    pub fn new(id_url: &str, name: String, about: About, dir: PathBuf) -> Self {
        let id_url = id_url.trim_end_matches('/').to_string();
        let identity = std::fs::read(dir.join("managed.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Identity>(&b).ok())
            .filter(|i| i.url == id_url);
        Self {
            id_url,
            about,
            dir,
            name,
            http: reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client"),
            identity: Mutex::new(identity),
            allowed: Default::default(),
            claim_issued: Mutex::new(None),
            beating: Default::default(),
        }
    }

    pub fn id_url(&self) -> &str {
        &self.id_url
    }

    pub fn relay_id(&self) -> Option<String> {
        self.identity.lock().unwrap().as_ref().map(|i| i.relay_id.clone())
    }

    pub fn allowed(&self) -> Allowed {
        self.allowed.lock().unwrap().clone()
    }

    fn show_claim_code(&self, code: &str) {
        tracing::info!("claim this relay at {}/account with code {code}", self.id_url);
        if let Err(e) = std::fs::write(self.dir.join("claim-code.txt"), format!("{code}\n")) {
            tracing::warn!("couldn't write the claim code: {e}");
        }
        *self.claim_issued.lock().unwrap() = Some(Instant::now());
    }

    async fn register(&self) -> anyhow::Result<Identity> {
        let r: Registered = self
            .http
            .post(format!("{}/relays", self.id_url))
            .json(&serde_json::json!({ "name": self.name }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let identity = Identity { url: self.id_url.clone(), relay_id: r.relay_id, secret: r.secret };
        std::fs::create_dir_all(&self.dir)?;
        let file = self.dir.join("managed.json");
        std::fs::write(&file, serde_json::to_vec(&identity)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
        }
        tracing::info!("registered with branchr as relay {}", identity.relay_id);
        self.show_claim_code(&r.claim_code);
        *self.identity.lock().unwrap() = Some(identity.clone());
        Ok(identity)
    }

    /// Reports in and learns who may use us. Skipped if one finished within `fresh`.
    pub async fn beat(&self, fresh: Duration) -> anyhow::Result<()> {
        let mut last = self.beating.lock().await;
        if last.is_some_and(|t| t.elapsed() < fresh) {
            return Ok(());
        }
        let known = self.identity.lock().unwrap().clone();
        let id = match known {
            Some(i) => i,
            None => self.register().await?,
        };
        let url = format!("{}/relays/{}", self.id_url, id.relay_id);
        let resp = self.http.post(format!("{url}/heartbeat")).bearer_auth(&id.secret).json(&self.about).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            tracing::warn!("branchr no longer knows this relay; registering again");
            *self.identity.lock().unwrap() = None;
            *self.allowed.lock().unwrap() = Allowed::default();
            let _ = std::fs::remove_file(self.dir.join("managed.json"));
            return Ok(());
        }
        let h: Heartbeat = resp.error_for_status()?.json().await?;
        if h.owner_id.is_some() {
            let _ = std::fs::remove_file(self.dir.join("claim-code.txt"));
            *self.claim_issued.lock().unwrap() = None;
        } else if self.claim_issued.lock().unwrap().is_none_or(|t| t.elapsed() >= CLAIM_REFRESH) {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Code {
                claim_code: String,
            }
            let c: Code = self.http.post(format!("{url}/claim-code")).bearer_auth(&id.secret).send().await?.error_for_status()?.json().await?;
            self.show_claim_code(&c.claim_code);
        }
        // Only ports inside our range, whatever we're told.
        let hubs = h
            .hubs
            .into_iter()
            .filter(|l| {
                l.udp_ports > 0 && l.udp_base >= self.about.udp_start && u32::from(l.udp_base) + u32::from(l.udp_ports) - 1 <= u32::from(self.about.udp_end)
            })
            .map(|l| (l.id, (l.udp_base, l.udp_ports)))
            .collect();
        *self.allowed.lock().unwrap() = Allowed { owner: h.owner_id, hubs };
        *last = Some(Instant::now());
        Ok(())
    }
}
