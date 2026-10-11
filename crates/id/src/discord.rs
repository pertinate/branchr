//! Discord OAuth: code exchange and the signed-in user, `identify` scope only.

use serde::Deserialize;

use crate::config::Config;
use crate::error::{Error, Result};

/// Honest about who we are; Discord asks API clients for a descriptive User-Agent.
pub const USER_AGENT: &str = concat!("branchr-id/", env!("CARGO_PKG_VERSION"), " (+https://branchr.us)");

#[derive(Deserialize, Debug)]
pub struct DiscordUser {
    pub id: String,
    pub username: String,
    pub global_name: Option<String>,
    pub avatar: Option<String>,
}

impl DiscordUser {
    pub fn display_name(&self) -> &str {
        self.global_name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&self.username)
    }

    pub fn avatar_url(&self) -> String {
        match &self.avatar {
            Some(h) => format!("https://cdn.discordapp.com/avatars/{}/{h}.{}?size=256", self.id, if h.starts_with("a_") { "gif" } else { "png" }),
            // Default avatars are picked from the id for new-style usernames.
            None => format!("https://cdn.discordapp.com/embed/avatars/{}.png", self.id.parse::<u64>().map(|i| (i >> 22) % 6).unwrap_or(0)),
        }
    }
}

pub fn authorize_url(cfg: &Config, state: &str) -> String {
    let mut u = url::Url::parse(&cfg.discord_authorize).expect("DISCORD_AUTHORIZE is a URL");
    u.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &cfg.discord_client_id)
        .append_pair("scope", "identify")
        .append_pair("redirect_uri", &cfg.discord_redirect())
        .append_pair("state", state)
        // Skip the consent screen for people who already approved us.
        .append_pair("prompt", "none");
    u.into()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// Exchanges Discord's code for the user it belongs to.
pub async fn user_for_code(http: &reqwest::Client, cfg: &Config, code: &str) -> Result<DiscordUser> {
    let r = http
        .post(format!("{}/oauth2/token", cfg.discord_api))
        .basic_auth(&cfg.discord_client_id, Some(&cfg.discord_client_secret))
        .form(&[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", &cfg.discord_redirect())])
        .send()
        .await
        .map_err(|e| Error::Upstream(format!("discord: {e}")))?;
    if !r.status().is_success() {
        let status = r.status();
        tracing::warn!("discord token exchange: {status} {}", r.text().await.unwrap_or_default());
        return Err(Error::Upstream(format!("discord rejected the sign-in ({status})")));
    }
    let token: TokenResponse = r.json().await.map_err(|e| Error::Upstream(format!("discord: {e}")))?;
    let r = http
        .get(format!("{}/users/@me", cfg.discord_api))
        .bearer_auth(token.access_token)
        .send()
        .await
        .map_err(|e| Error::Upstream(format!("discord: {e}")))?;
    if !r.status().is_success() {
        return Err(Error::Upstream(format!("discord user lookup failed ({})", r.status())));
    }
    r.json().await.map_err(|e| Error::Upstream(format!("discord: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatars() {
        let u = DiscordUser { id: "80351110224678912".into(), username: "nelly".into(), global_name: None, avatar: Some("a_abc".into()) };
        assert!(u.avatar_url().ends_with("/80351110224678912/a_abc.gif?size=256"));
        assert_eq!(u.display_name(), "nelly");
        let u = DiscordUser { avatar: None, global_name: Some("Nelly".into()), ..u };
        assert_eq!(u.avatar_url(), format!("https://cdn.discordapp.com/embed/avatars/{}.png", (80351110224678912u64 >> 22) % 6));
        assert_eq!(u.display_name(), "Nelly");
    }
}
