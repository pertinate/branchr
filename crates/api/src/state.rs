use std::sync::Arc;

use dashmap::DashMap;
use proto::Id;
use proto::id::IdGen;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::hub::Hub;
use crate::ratelimit::RateLimiter;
use crate::emote_providers::EmoteProviders;

pub type AppState = Arc<State>;

pub struct State {
    pub db: SqlitePool,
    pub hub: Hub,
    pub config: Config,
    pub ids: IdGen,
    pub emotes: EmoteProviders,
    /// sha256(token) -> user id. Sessions are immutable so this never goes stale except on logout.
    pub sessions: DashMap<[u8; 32], Id>,
    /// channel id -> guild id, channels never move between guilds.
    pub channel_guild: DashMap<Id, Id>,
    pub message_limiter: RateLimiter,
    /// Whether new people may join (owner-adjustable; starts from OPEN_REGISTRATION).
    pub open_registration: std::sync::atomic::AtomicBool,
    /// Set when this server accepts branchr accounts.
    pub federation: Option<Arc<crate::federation::Federation>>,
}

impl State {
    pub async fn guild_of_channel(&self, channel: Id) -> sqlx::Result<Id> {
        if let Some(g) = self.channel_guild.get(&channel) {
            return Ok(*g);
        }
        let (g,): (i64,) = sqlx::query_as("SELECT guild_id FROM channels WHERE id = ?")
            .bind(channel.0)
            .fetch_one(&self.db)
            .await?;
        self.channel_guild.insert(channel, Id(g));
        Ok(Id(g))
    }
}
