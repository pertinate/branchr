pub mod admin;
pub mod attachments;
pub mod bans;
pub mod channels;
pub mod emotes;
pub mod guilds;
pub mod messages;
pub mod pictures;
pub mod roles;
pub mod search;
pub mod users;

use std::sync::Arc;

use proto::Id;
use proto::perms::{self, Permissions};

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

/// Membership, seeing the channel, and the permission `p` in it (after its overwrites).
/// A channel you can't see answers as missing.
pub async fn channel_perm(state: &AppState, channel: Id, user: Id, p: Permissions) -> AppResult<(Id, Arc<GuildPerms>)> {
    let guild = state.guild_of_channel(channel).await?;
    require_member(state, guild, user).await?;
    let g = state.perms.guild(&state.db, guild).await?;
    let have = g.in_channel(user, channel);
    if have & perms::VIEW_CHANNEL == 0 {
        return Err(AppError::NotFound);
    }
    if have & p != p {
        return Err(AppError::Forbidden);
    }
    Ok((guild, g))
}
