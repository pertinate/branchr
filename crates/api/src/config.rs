use std::net::SocketAddr;
use std::path::PathBuf;

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
            upload_dir: var("UPLOAD_DIR").map(PathBuf::from).unwrap_or_else(|| {
                // Next to the SQLite file by default, so one volume holds all state.
                let db = var("DATABASE_URL").unwrap_or_else(|| "sqlite://data/discord.db".into());
                let path = db.trim_start_matches("sqlite://").to_string();
                std::path::Path::new(&path).parent().map(|p| p.join("uploads")).unwrap_or_else(|| "uploads".into())
            }),
            max_upload_bytes: var("MAX_UPLOAD_MB").map(|v| v.parse::<u64>()).transpose()?.unwrap_or(100) * 1024 * 1024,
        })
    }
}
