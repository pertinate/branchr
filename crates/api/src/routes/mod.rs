pub mod admin;
pub mod attachments;
pub mod channels;
pub mod emotes;
pub mod guilds;
pub mod messages;
pub mod roles;
pub mod users;

use std::sync::Arc;

use proto::Id;
use proto::perms::Permissions;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::perms::GuildPerms;
use crate::state::AppState;

pub async fn require_member(state: &AppState, guild: Id, user: Id) -> AppResult<()> {
    if db::is_member(&state.db, guild, user).await? { Ok(()) } else { Err(AppError::NotFound) }
}

/// Checks membership and the permission `p`, returning the guild's permissions for any
/// further checks (hierarchy, other bits).
pub async fn require_perm(state: &AppState, guild: Id, user: Id, p: Permissions) -> AppResult<Arc<GuildPerms>> {
    require_member(state, guild, user).await?;
    let g = state.perms.guild(&state.db, guild).await?;
    if g.has(user, p) { Ok(g) } else { Err(AppError::Forbidden) }
}

/// Resolves a channel's guild and checks membership.
pub async fn channel_access(state: &AppState, channel: Id, user: Id) -> AppResult<Id> {
    let guild = state.guild_of_channel(channel).await?;
    require_member(state, guild, user).await?;
    Ok(guild)
}

/// `channel_access` plus the permission `p` in that channel.
pub async fn channel_perm(state: &AppState, channel: Id, user: Id, p: Permissions) -> AppResult<(Id, Arc<GuildPerms>)> {
    let guild = state.guild_of_channel(channel).await?;
    Ok((guild, require_perm(state, guild, user, p).await?))
}
