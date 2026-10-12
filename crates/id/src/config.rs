use std::net::SocketAddr;

use anyhow::Context;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    /// Where this service is reached, e.g. `https://branchr.us`. Issuer of tokens, and the
    /// base of the Discord redirect.
    pub public_url: String,
    pub database_url: String,
    pub discord_client_id: String,
    pub discord_client_secret: String,
    /// Overridable so tests can stand in for Discord.
    pub discord_api: String,
    pub discord_authorize: String,
    /// Exact redirect URIs clients may ask for (`branchr://auth/callback` for the desktop app).
    pub redirects: Vec<String>,
    /// The SFU that carries DM calls (`wss://…/ws`) and the secret its tokens are signed
    /// with. Calls are off without both.
    pub sfu_url: Option<String>,
    pub voice_secret: Option<Vec<u8>>,
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            bind: var("ID_BIND").unwrap_or_else(|| "0.0.0.0:8070".into()).parse().context("ID_BIND")?,
            public_url: var("PUBLIC_URL").unwrap_or_else(|| "https://branchr.us".into()).trim_end_matches('/').into(),
            database_url: var("DATABASE_URL").context("DATABASE_URL is required (postgres://…)")?,
            discord_client_id: var("DISCORD_CLIENT_ID").context("DISCORD_CLIENT_ID is required")?,
            discord_client_secret: var("DISCORD_CLIENT_SECRET").context("DISCORD_CLIENT_SECRET is required")?,
            discord_api: var("DISCORD_API").unwrap_or_else(|| "https://discord.com/api".into()),
            discord_authorize: var("DISCORD_AUTHORIZE").unwrap_or_else(|| "https://discord.com/oauth2/authorize".into()),
            redirects: var("ALLOWED_REDIRECTS")
                .unwrap_or_else(|| "branchr://auth/callback".into())
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            sfu_url: var("ID_SFU_URL"),
            voice_secret: var("ID_VOICE_SECRET").map(String::into_bytes),
        })
    }

    pub fn discord_redirect(&self) -> String {
        format!("{}/auth/discord/callback", self.public_url)
    }
}
