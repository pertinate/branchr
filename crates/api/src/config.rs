use std::net::SocketAddr;
use std::path::PathBuf;

use crate::storage::StorageConfig;

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
    /// The product site, served at `/` (the app is at `/app/`).
    pub site_dir: Option<PathBuf>,
    /// Shared secret used to sign voice tokens for the SFU(s).
    pub voice_secret: Vec<u8>,
    /// Public WebSocket urls of SFU instances; a voice channel is pinned to one by hash.
    pub sfu_urls: Vec<String>,
    /// Allow anyone to register.
    pub open_registration: bool,
    /// Where uploaded files are stored: `UPLOAD_DIR`, or an S3 bucket when `S3_ENDPOINT` is set.
    pub storage: StorageConfig,
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
            site_dir: var("SITE_DIR").map(PathBuf::from),
            voice_secret,
            sfu_urls: var("SFU_URLS")
                .unwrap_or_else(|| "ws://localhost:8090/ws".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            open_registration: var("OPEN_REGISTRATION").map(|v| v != "false").unwrap_or(true),
            storage: match var("STORAGE").as_deref().or(var("S3_ENDPOINT").map(|_| "s3")) {
                None | Some("local") => StorageConfig::Local(upload_dir()),
                Some("s3") => StorageConfig::S3 {
                    endpoint: var("S3_ENDPOINT").ok_or_else(|| anyhow::anyhow!("STORAGE=s3 needs S3_ENDPOINT"))?,
                    public_url: var("S3_PUBLIC_URL"),
                    bucket: var("S3_BUCKET").unwrap_or_else(|| "branchr".into()),
                    region: var("S3_REGION").unwrap_or_else(|| "us-east-1".into()),
                    access_key: var("S3_ACCESS_KEY").ok_or_else(|| anyhow::anyhow!("STORAGE=s3 needs S3_ACCESS_KEY"))?,
                    secret_key: var("S3_SECRET_KEY").ok_or_else(|| anyhow::anyhow!("STORAGE=s3 needs S3_SECRET_KEY"))?,
                    path_style: var("S3_PATH_STYLE").is_none_or(|v| v != "false"),
                },
                Some(other) => anyhow::bail!("STORAGE must be local or s3 (got {other})"),
            },
            max_upload_bytes: var("MAX_UPLOAD_MB").map(|v| v.parse::<u64>()).transpose()?.unwrap_or(500) * 1024 * 1024,
            auth_mode: match var("AUTH_MODE").as_deref() {
                None | Some("local") => AuthMode::Local,
                Some("federated") => AuthMode::Federated,
                Some("both") => AuthMode::Both,
                Some(other) => anyhow::bail!("AUTH_MODE must be local, federated or both (got {other})"),
            },
            branchr_id_url: var("BRANCHR_ID_URL").unwrap_or_else(|| "https://branchr.us".into()).trim_end_matches('/').into(),
            instance_name: var("INSTANCE_NAME").unwrap_or_else(|| "branchr hub".into()),
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

/// `UPLOAD_DIR`: local file storage, and what `migrate-storage` copies from.
pub fn upload_dir() -> PathBuf {
    std::env::var("UPLOAD_DIR").ok().filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| data_dir().join("uploads"))
}
