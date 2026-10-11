use serde::{Deserialize, Serialize};

use crate::Id;

macro_rules! wire {
    ($($item:item)*) => {
        $(
            #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
            #[serde(rename_all = "camelCase")]
            #[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
            $item
        )*
    };
}

wire! {
    pub struct User {
        pub id: Id,
        pub username: String,
        pub display_name: String,
        pub avatar_url: Option<String>,
    }

    pub struct Guild {
        pub id: Id,
        pub name: String,
        pub icon_url: Option<String>,
        pub owner_id: Id,
    }

    pub struct Channel {
        pub id: Id,
        pub guild_id: Id,
        pub name: String,
        pub kind: ChannelKind,
        /// Category this channel is nested under.
        pub parent_id: Option<Id>,
        pub position: i32,
        pub topic: Option<String>,
        /// Last message id, used for unread indicators.
        pub last_message_id: Option<Id>,
    }

    pub struct Member {
        pub guild_id: Id,
        pub user: User,
        pub nick: Option<String>,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub joined_at: i64,
    }

    pub struct Message {
        pub id: Id,
        pub channel_id: Id,
        pub author: User,
        pub content: String,
        #[cfg_attr(feature = "ts", ts(type = "number | null"))]
        pub edited_at: Option<i64>,
        /// Present when this message is a reply.
        pub reply_to: Option<Id>,
        pub reactions: Vec<Reaction>,
        #[serde(default)]
        pub attachments: Vec<Attachment>,
        /// Client-generated id echoed back so optimistic sends can be reconciled.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub nonce: Option<String>,
    }

    pub struct Attachment {
        pub id: Id,
        pub filename: String,
        pub content_type: String,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub size: u64,
        /// Pixel size for images/videos when the client reported it (avoids layout shift).
        pub width: Option<u32>,
        pub height: Option<u32>,
        /// Path relative to the server origin.
        pub url: String,
    }

    pub struct Reaction {
        /// Unicode emoji, or `e:<emoteId>` for a guild emote.
        pub emoji: String,
        pub count: u32,
        /// Whether the requesting user reacted. Only meaningful in REST responses;
        /// gateway clients track their own reactions.
        pub me: bool,
    }

    /// A 7TV emote added to a guild.
    pub struct Emote {
        pub id: Id,
        pub guild_id: Id,
        pub name: String,
        /// 7TV emote id; CDN url is `https://cdn.7tv.app/emote/{providerId}/{1x|2x|3x|4x}.webp`.
        pub provider_id: String,
        pub animated: bool,
        pub width: u32,
        pub height: u32,
    }

    pub struct Invite {
        pub code: String,
        pub guild_id: Id,
        pub guild_name: String,
        pub member_count: u32,
    }

    pub struct VoiceState {
        pub user_id: Id,
        pub guild_id: Id,
        pub channel_id: Id,
        pub self_mute: bool,
        pub self_deaf: bool,
        pub self_video: bool,
        pub self_stream: bool,
    }

    pub struct Presence {
        pub user_id: Id,
        pub status: Status,
    }

    /// A 7TV search hit (not yet added to a guild).
    pub struct SevenTvEmote {
        pub id: String,
        pub name: String,
        pub animated: bool,
        pub width: u32,
        pub height: u32,
        pub owner: Option<String>,
    }

    pub struct AuthResponse {
        pub token: String,
        pub user: User,
    }

    pub struct VoiceServer {
        /// WebSocket url of the SFU for this channel.
        pub endpoint: String,
        pub token: String,
        pub guild_id: Id,
        pub channel_id: Id,
    }

    pub struct ApiError {
        pub error: String,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ChannelKind {
    Text,
    Voice,
    Category,
}

impl ChannelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Voice => "voice",
            Self::Category => "category",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "text" => Self::Text,
            "voice" => Self::Voice,
            "category" => Self::Category,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum Status {
    Online,
    Idle,
    Dnd,
    #[default]
    Offline,
}
