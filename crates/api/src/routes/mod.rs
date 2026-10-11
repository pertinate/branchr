pub mod attachments;
pub mod channels;
pub mod emotes;
pub mod guilds;
pub mod messages;
pub mod users;

use proto::Id;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub async fn require_member(state: &AppState, guild: Id, user: Id) -> AppResult<()> {
    if db::is_member(&state.db, guild, user).await? { Ok(()) } else { Err(AppError::NotFound) }
}

pub async fn require_owner(state: &AppState, guild: Id, user: Id) -> AppResult<()> {
    let g = db::guild(&state.db, guild).await?;
    if g.owner_id == user { Ok(()) } else { Err(AppError::Forbidden) }
}

/// Resolves a channel's guild and checks membership.
pub async fn channel_access(state: &AppState, channel: Id, user: Id) -> AppResult<Id> {
    let guild = state.guild_of_channel(channel).await?;
    require_member(state, guild, user).await?;
    Ok(guild)
}
