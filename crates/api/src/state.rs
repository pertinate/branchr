use std::sync::Arc;

use dashmap::DashMap;
use proto::Id;
use proto::id::IdGen;

use proto::gateway::{ChannelRef, ServerEvent};
use proto::perms;

use crate::config::Config;
use crate::db;
use crate::error::AppResult;
use crate::perms::GuildPerms;
use crate::db::Db;
use crate::hub::Hub;
use crate::ratelimit::RateLimiter;
use crate::emote_providers::EmoteProviders;

pub type AppState = Arc<State>;

pub struct State {
    pub db: Db,
    pub storage: crate::storage::Storage,
    pub hub: Hub,
    pub perms: crate::perms::Perms,
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
        let (g,): (i64,) = sqlx::query_as("SELECT guild_id FROM channels WHERE id = $1")
            .bind(channel.0)
            .fetch_one(&self.db)
            .await?;
        self.channel_guild.insert(channel, Id(g));
        Ok(Id(g))
    }

    /// Sends a channel's event to the members who can see it (everyone, usually).
    pub async fn to_channel(&self, guild: Id, channel: Id, ev: &ServerEvent) {
        match self.perms.guild(&self.db, guild).await {
            Ok(gp) if gp.is_public(channel) => self.hub.to_guild(guild, ev),
            Ok(gp) => self.hub.to_guild_where(guild, ev, |u| gp.can_in(u, channel, perms::VIEW_CHANNEL)),
            Err(e) => tracing::warn!("permissions for guild {guild:?}: {e:?}"),
        }
    }

    /// After roles or overwrites change: channels appear for people who can now see them
    /// and disappear for those who can't. `before` is the guild's permissions beforehand.
    pub async fn resync_visibility(&self, guild: Id, before: &GuildPerms) -> AppResult<()> {
        self.perms.invalidate(guild);
        let after = self.perms.guild(&self.db, guild).await?;
        let users = self.hub.guild_users(guild);
        if users.is_empty() {
            return Ok(());
        }
        let channels = db::channels(&self.db, guild).await?;
        for user in users {
            for c in &channels {
                let (was, now) = (before.can_in(user, c.id, perms::VIEW_CHANNEL), after.can_in(user, c.id, perms::VIEW_CHANNEL));
                if now && !was {
                    self.hub.to_user(user, &ServerEvent::ChannelCreate(c.clone()));
                } else if was && !now {
                    self.hub.to_user(user, &ServerEvent::ChannelDelete(ChannelRef { id: c.id, guild_id: guild }));
                }
            }
        }
        Ok(())
    }
}
