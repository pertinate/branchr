//! Realtime gateway protocol (client <-> api over WebSocket, JSON text frames).

use serde::{Deserialize, Serialize};

use crate::Id;
use crate::models::*;

/// Messages sent by the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", content = "d", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ClientOp {
    Identify { token: String },
    Heartbeat,
    /// Join/leave/update voice. `channel_id: None` leaves voice.
    VoiceStateUpdate(VoiceStateUpdate),
    Typing {
        #[serde(rename = "channelId")]
        channel_id: Id,
    },
    SetStatus { status: Status },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct VoiceStateUpdate {
    pub guild_id: Id,
    pub channel_id: Option<Id>,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_video: bool,
    pub self_stream: bool,
}

/// Messages sent by the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d", rename_all = "SCREAMING_SNAKE_CASE")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ServerEvent {
    Hello(Hello),
    Ready(Ready),
    HeartbeatAck,
    InvalidSession,

    GuildCreate(ReadyGuild),
    GuildUpdate(Guild),
    GuildDelete(GuildRef),

    ChannelCreate(Channel),
    ChannelUpdate(Channel),
    ChannelDelete(ChannelRef),

    MemberAdd(Member),
    MemberUpdate(Member),
    MemberRemove(MemberRef),

    MessageCreate(Message),
    MessageUpdate(Message),
    MessageDelete(MessageRef),

    ReactionAdd(ReactionEvent),
    ReactionRemove(ReactionEvent),

    EmoteCreate(Emote),
    /// Renamed by the guild (third-party emotes keep their image, the name is local).
    EmoteUpdate(Emote),
    EmoteDelete(EmoteRef),

    TypingStart(TypingStart),
    PresenceUpdate(Presence),
    UserUpdate(User),

    /// Voice state for a user changed. `channel_id: None` in `VoiceStateRemove` means left.
    VoiceStateUpdate(VoiceState),
    VoiceStateRemove(VoiceStateRef),
    /// Sent only to the user who requested to join voice.
    VoiceServer(VoiceServer),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Hello {
    pub heartbeat_interval_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Ready {
    pub user: User,
    pub session_id: String,
    pub guilds: Vec<ReadyGuild>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ReadyGuild {
    pub guild: Guild,
    pub channels: Vec<Channel>,
    pub members: Vec<Member>,
    pub emotes: Vec<Emote>,
    pub voice_states: Vec<VoiceState>,
    pub presences: Vec<Presence>,
}

macro_rules! refs {
    ($($name:ident { $($field:ident),* })*) => {
        $(
            #[derive(Debug, Clone, Serialize, Deserialize)]
            #[serde(rename_all = "camelCase")]
            #[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
            pub struct $name { $(pub $field: Id),* }
        )*
    };
}

refs! {
    GuildRef { id }
    ChannelRef { id, guild_id }
    MemberRef { guild_id, user_id }
    MessageRef { id, channel_id }
    EmoteRef { id, guild_id }
    VoiceStateRef { guild_id, user_id }
    TypingStart { channel_id, user_id }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ReactionEvent {
    pub channel_id: Id,
    pub message_id: Id,
    pub user_id: Id,
    pub emoji: String,
}
