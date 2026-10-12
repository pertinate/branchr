use std::net::SocketAddr;
use std::path::PathBuf;

/// Which accounts this server accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    /// Its own username/password accounts only (standalone; the default).
    Local,
    /// branchr accounts only.
    Federated,
    /// Both: local accounts keep working while people move to branchr accounts.
    Both,
}

/// All configuration comes from the environment so a single `.env` / compose file drives a deployment.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    /// Directory with the built web client; served as an SPA when set.
    pub web_dir: Option<PathBuf>,
    /// Shared secret used to sign voice tokens for the SFU(s).
    pub voice_secret: Vec<u8>,
    /// Public WebSocket urls of SFU instances; a voice channel is pinned to one by hash.
    pub sfu_urls: Vec<String>,
    /// Allow anyone to register.
    pub open_registration: bool,
    /// Where uploaded attachments are stored.
    pub upload_dir: PathBuf,
    pub max_upload_bytes: u64,
    pub auth_mode: AuthMode,
    /// The branchr ID this server federates with.
    pub branchr_id_url: String,
    /// Shown to the owner when claiming, and in discovery later.
    pub instance_name: String,
    /// This server's own address, registered with branchr ID.
    pub public_url: String,
    /// Where the claim code is written for the owner (next to the database by default).
    pub claim_file: PathBuf,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let voice_secret = match var("VOICE_SECRET") {
            Some(s) => s.into_bytes(),
            None => {
                tracing::warn!("VOICE_SECRET not set, using an insecure development secret");
                b"dev-voice-secret".to_vec()
            }
        };
        Ok(Self {
            bind: var("API_BIND").unwrap_or_else(|| "0.0.0.0:8080".into()).parse()?,
            database_url: var("DATABASE_URL").unwrap_or_else(|| "sqlite://data/discord.db".into()),
            web_dir: var("WEB_DIR").map(PathBuf::from),
            voice_secret,
            sfu_urls: var("SFU_URLS")
                .unwrap_or_else(|| "ws://localhost:8090/ws".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            open_registration: var("OPEN_REGISTRATION").map(|v| v != "false").unwrap_or(true),
            upload_dir: var("UPLOAD_DIR").map(PathBuf::from).unwrap_or_else(|| data_dir().join("uploads")),
            max_upload_bytes: var("MAX_UPLOAD_MB").map(|v| v.parse::<u64>()).transpose()?.unwrap_or(500) * 1024 * 1024,
            auth_mode: match var("AUTH_MODE").as_deref() {
                None | Some("local") => AuthMode::Local,
                Some("federated") => AuthMode::Federated,
                Some("both") => AuthMode::Both,
                Some(other) => anyhow::bail!("AUTH_MODE must be local, federated or both (got {other})"),
            },
            branchr_id_url: var("BRANCHR_ID_URL").unwrap_or_else(|| "https://branchr.us".into()).trim_end_matches('/').into(),
            instance_name: var("INSTANCE_NAME").unwrap_or_else(|| "branchr server".into()),
            public_url: var("PUBLIC_URL").unwrap_or_default(),
            claim_file: var("CLAIM_FILE").map(PathBuf::from).unwrap_or_else(|| data_dir().join("claim-code.txt")),
        })
    }
}

/// Where files live by default: next to the SQLite file, so one volume holds all state;
/// `data/` when the database is Postgres.
fn data_dir() -> PathBuf {
    let db = std::env::var("DATABASE_URL").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "sqlite://data/discord.db".into());
    match db.strip_prefix("sqlite://").or_else(|| db.strip_prefix("sqlite:")) {
        Some(path) => std::path::Path::new(path.split('?').next().unwrap_or(path)).parent().map(PathBuf::from).unwrap_or_default(),
        None => "data".into(),
    }
}
