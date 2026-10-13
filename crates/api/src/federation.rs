//! Accepting branchr accounts (`AUTH_MODE=federated|both`).
//!
//! In the background the server registers with branchr ID once, writes the claim code for
//! its owner to `CLAIM_FILE` (and the log), and checks until someone claims it. Logins
//! present a short-lived pass from branchr ID, verified here against its published keys.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::db::Db;

#[derive(Clone, Debug)]
pub struct Identity {
    pub instance_id: String,
    secret: String,
    pub owner: Option<String>,
}

/// What a branchr ID pass says about the user.
#[derive(Deserialize, Debug)]
pub struct Pass {
    /// The branchr account id.
    pub sub: String,
    pub name: String,
    pub username: String,
    pub avatar: Option<String>,
}

pub struct Federation {
    id_url: String,
    http: reqwest::Client,
    identity: RwLock<Option<Identity>>,
    keys: RwLock<HashMap<String, DecodingKey>>,
    /// Unknown key ids trigger a refetch, at most this often.
    last_fetch: Mutex<Option<Instant>>,
    /// When the current claim code was issued (they last 24 hours).
    claim_issued: Mutex<Option<Instant>>,
}

/// Refresh the claim code a little before branchr ID expires it.
/// How often a claimed server checks its claim (also tells branchr ID it's still up).
const CLAIMED_POLL: Duration = Duration::from_secs(300);
const CLAIM_REFRESH: Duration = Duration::from_secs(23 * 3600);

const REFETCH_EVERY: Duration = Duration::from_secs(60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Register<'a> {
    name: &'a str,
    public_url: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registered {
    instance_id: String,
    secret: String,
    claim_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    claimed: bool,
    owner_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimCode {
    claim_code: String,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    x: String,
    #[serde(default)]
    crv: String,
}

impl Federation {
    pub fn new(config: &Config) -> Self {
        Self {
            id_url: config.branchr_id_url.clone(),
            http: reqwest::Client::builder()
                .user_agent(concat!("branchr-server/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(10))
                .build()
                .expect("http client"),
            identity: RwLock::new(None),
            keys: RwLock::new(HashMap::new()),
            last_fetch: Mutex::new(None),
            claim_issued: Mutex::new(None),
        }
    }

    /// A short-lived pass for branchr ID's gateway, letting us in under our key.
    pub async fn relay_pass(&self) -> anyhow::Result<String> {
        #[derive(Deserialize)]
        struct T {
            token: String,
        }
        let id = self.identity().ok_or_else(|| anyhow::anyhow!("not registered with branchr ID yet"))?;
        let t: T = self
            .http
            .post(format!("{}/instances/{}/relay-pass", self.id_url, id.instance_id))
            .bearer_auth(&id.secret)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(t.token)
    }

    pub fn id_url(&self) -> &str {
        &self.id_url
    }

    /// Sends this host's published servers to branchr ID (all of them, replacing the last set).
    pub async fn publish(&self, servers: &[proto::social::PublishedServer], public_url: &str, name: &str) -> anyhow::Result<()> {
        let Some(id) = self.identity() else { return Ok(()) };
        self.http
            .put(format!("{}/instances/{}/listings", self.id_url, id.instance_id))
            .bearer_auth(&id.secret)
            .json(&serde_json::json!({ "servers": servers, "publicUrl": public_url, "name": name }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub fn identity(&self) -> Option<Identity> {
        self.identity.read().clone()
    }

    /// Registers (once), waits for the claim, then keeps checking it now and then (an owner can
    /// release it from their account). Runs for the life of the server.
    pub async fn run(&self, db: Db, config: Config) {
        let poll = Duration::from_secs(std::env::var("BRANCHR_POLL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30));
        let mut backoff = Duration::from_secs(2);
        loop {
            match self.step(&db, &config).await {
                Ok(true) => backoff = CLAIMED_POLL,
                Ok(false) => backoff = poll,
                Err(e) => {
                    tracing::warn!("branchr ID ({}): {e:#}", self.id_url);
                    backoff = (backoff * 2).min(Duration::from_secs(300));
                }
            }
            tokio::time::sleep(backoff).await;
        }
    }

    /// One round; true once the server is claimed.
    async fn step(&self, db: &Db, config: &Config) -> anyhow::Result<bool> {
        if self.identity.read().is_none() {
            let row: Option<(String, String, String, Option<String>)> =
                sqlx::query_as("SELECT branchr_id_url, instance_id, secret, owner_global_id FROM federation WHERE id = 1").fetch_optional(db).await?;
            match row {
                Some((url, instance_id, secret, owner)) if url == self.id_url => {
                    *self.identity.write() = Some(Identity { instance_id, secret, owner });
                }
                stale => {
                    if stale.is_some() {
                        tracing::warn!("BRANCHR_ID_URL changed; registering with {}", self.id_url);
                    }
                    // With a setup code from branchr's website, we're already someone's.
                    let r: Registered = match &config.setup_code {
                        Some(code) => {
                            let resp = self
                                .http
                                .post(format!("{}/instances/setup", self.id_url))
                                .json(&serde_json::json!({ "code": code, "publicUrl": config.public_url }))
                                .send()
                                .await?;
                            if !resp.status().is_success() {
                                let body = resp.text().await.unwrap_or_default();
                                anyhow::bail!("setup code refused: {body}");
                            }
                            resp.json().await?
                        }
                        None => self
                            .http
                            .post(format!("{}/instances", self.id_url))
                            .json(&Register { name: &config.instance_name, public_url: &config.public_url })
                            .send()
                            .await?
                            .error_for_status()?
                            .json()
                            .await?,
                    };
                    sqlx::query(
                        "INSERT INTO federation (id, branchr_id_url, instance_id, secret) VALUES (1, $1, $2, $3)
                         ON CONFLICT (id) DO UPDATE SET branchr_id_url = $1, instance_id = $2, secret = $3, owner_global_id = NULL",
                    )
                    .bind(&self.id_url)
                    .bind(&r.instance_id)
                    .bind(&r.secret)
                    .execute(db)
                    .await?;
                    tracing::info!("registered with branchr ID as {}", r.instance_id);
                    if r.claim_code.is_empty() {
                        tracing::info!("set up with a code: it's already yours");
                    } else {
                        show_claim_code(config, &r.claim_code);
                    }
                    *self.claim_issued.lock() = Some(Instant::now());
                    *self.identity.write() = Some(Identity { instance_id: r.instance_id, secret: r.secret, owner: None });
                }
            }
        }
        let id = self.identity().expect("set above");
        let status_url = format!("{}/instances/{}", self.id_url, id.instance_id);
        let st: Status = self.http.get(&status_url).bearer_auth(&id.secret).send().await?.error_for_status()?.json().await?;
        if st.claimed && st.owner_id == id.owner {
            return Ok(true);
        }
        if !st.claimed && id.owner.is_some() {
            // Released by its owner: claimable again.
            sqlx::query("UPDATE federation SET owner_global_id = NULL WHERE id = 1").execute(db).await?;
            if let Some(i) = self.identity.write().as_mut() {
                i.owner = None;
            }
            *self.claim_issued.lock() = None;
            tracing::info!("the claim on this server was released");
        }
        if st.claimed {
            sqlx::query("UPDATE federation SET owner_global_id = $1 WHERE id = 1").bind(&st.owner_id).execute(db).await?;
            if let Some(i) = self.identity.write().as_mut() {
                i.owner = st.owner_id.clone();
            }
            let _ = std::fs::remove_file(&config.claim_file);
            tracing::info!("claimed by branchr account {}", st.owner_id.as_deref().unwrap_or("?"));
            return Ok(true);
        }
        // A fresh code after a restart (we don't keep it) or before the last one expires.
        let stale = self.claim_issued.lock().is_none_or(|t| t.elapsed() >= CLAIM_REFRESH);
        if stale {
            let c: ClaimCode = self.http.post(format!("{status_url}/claim-code")).bearer_auth(&id.secret).send().await?.error_for_status()?.json().await?;
            show_claim_code(config, &c.claim_code);
            *self.claim_issued.lock() = Some(Instant::now());
        }
        Ok(false)
    }

    async fn fetch_keys(&self) -> anyhow::Result<()> {
        let jwks: Jwks = self.http.get(format!("{}/.well-known/jwks.json", self.id_url)).send().await?.error_for_status()?.json().await?;
        let mut keys = HashMap::new();
        for k in jwks.keys.into_iter().filter(|k| k.crv == "Ed25519") {
            keys.insert(k.kid, DecodingKey::from_ed_components(&k.x)?);
        }
        *self.keys.write() = keys;
        Ok(())
    }

    /// Checks a pass: signed by branchr ID, for this server, not expired.
    pub async fn verify(&self, token: &str) -> Option<Pass> {
        let instance = self.identity()?.instance_id;
        let kid = jsonwebtoken::decode_header(token).ok()?.kid?;
        if !self.keys.read().contains_key(&kid) {
            // New key (rotation) or first use: refetch, but not on every bad token.
            let due = self.last_fetch.lock().is_none_or(|t| t.elapsed() >= REFETCH_EVERY);
            if due {
                *self.last_fetch.lock() = Some(Instant::now());
                if let Err(e) = self.fetch_keys().await {
                    tracing::warn!("branchr ID keys: {e:#}");
                }
            }
        }
        let keys = self.keys.read();
        let key = keys.get(&kid)?;
        let mut v = Validation::new(Algorithm::EdDSA);
        v.set_issuer(&[&self.id_url]);
        v.set_audience(&[&instance]);
        jsonwebtoken::decode::<Pass>(token, key, &v).ok().map(|d| d.claims)
    }
}

fn show_claim_code(config: &Config, code: &str) {
    tracing::info!("claim this server at {}: sign in and enter code {code}", config.branchr_id_url);
    if let Err(e) = std::fs::write(&config.claim_file, format!("{code}\n")) {
        tracing::warn!("couldn't write {}: {e}", config.claim_file.display());
    }
}

/// A free local username based on `wanted` (letters, digits, _ and . only, 2-32 long).
pub async fn free_username(db: &Db, wanted: &str) -> sqlx::Result<String> {
    let mut base: String = wanted.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.').take(28).collect();
    if base.len() < 2 {
        base = "user".into();
    }
    for n in 0..1000u32 {
        let candidate = if n == 0 { base.clone() } else { format!("{base}{n}") };
        let taken: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM users WHERE lower(username) = lower($1)").bind(&candidate).fetch_optional(db).await?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
    Ok(format!("{base}{}", rand::random::<u32>()))
}
