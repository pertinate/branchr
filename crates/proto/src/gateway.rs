//! Realtime gateway protocol (client <-> api over WebSocket, JSON text frames).

use serde::{Deserialize, Serialize};

use crate::Id;
use crate::models::*;

/// Messages sent by the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", content = "d", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ClientOp {
    /// `status` and `custom` are what the client last chose (kept on its side), so a
    /// reconnect doesn't reset them.
    Identify {
        token: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<Status>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom: Option<String>,
    },
    Heartbeat,
    /// Join/leave/update voice. `channel_id: None` leaves voice.
    VoiceStateUpdate(VoiceStateUpdate),
    Typing {
        #[serde(rename = "channelId")]
        channel_id: Id,
    },
    /// Sets both: a missing `custom` clears it.
    SetStatus {
        status: Status,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom: Option<String>,
    },
    /// Read a channel up to `message_id`; clears its mention count.
    Ack {
        #[serde(rename = "channelId")]
        channel_id: Id,
        #[serde(rename = "messageId")]
        message_id: Id,
    },
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

    RoleCreate(Role),
    RoleUpdate(Role),
    RoleDelete(RoleRef),

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
    /// Sent to all of a user's sessions when they read a channel.
    ReadStateUpdate(ReadState),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ReadState {
    pub channel_id: Id,
    /// None when nothing has been read.
    pub last_read_id: Option<Id>,
    pub mention_count: u32,
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
    /// Largest attachment this server accepts, so clients can refuse up front.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub max_upload_bytes: u64,
    pub read_states: Vec<ReadState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ReadyGuild {
    pub guild: Guild,
    pub channels: Vec<Channel>,
    pub roles: Vec<Role>,
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
    RoleRef { id, guild_id }
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
