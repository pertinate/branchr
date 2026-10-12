//! branchr ID's social side: people (by account), friends and blocks, and direct messages,
//! over its REST API and its own gateway. Accounts are UUIDs; DM channels and messages are
//! snowflakes like everything on instances.

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
    /// Someone with a branchr account.
    pub struct Person {
        /// Account UUID.
        pub id: String,
        /// Unique, lowercase; what people add you by.
        pub handle: String,
        pub display_name: String,
        pub avatar_url: Option<String>,
    }

    pub struct Relationship {
        pub person: Person,
        pub kind: RelationshipKind,
    }

    pub struct DmChannel {
        pub id: Id,
        /// Everyone in it but you.
        pub recipients: Vec<Person>,
        pub last_message_id: Option<Id>,
        /// Your read position.
        pub last_read_id: Option<Id>,
    }

    pub struct DmMessage {
        pub id: Id,
        pub channel_id: Id,
        pub author: Person,
        pub content: String,
        #[cfg_attr(feature = "ts", ts(type = "number | null"))]
        pub edited_at: Option<i64>,
        pub reply_to: Option<Id>,
        /// Echoed back to the sender so optimistic sends can be matched up.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub nonce: Option<String>,
    }

    pub struct SocialReady {
        pub me: Person,
        pub relationships: Vec<Relationship>,
        pub channels: Vec<DmChannel>,
        /// Account ids of friends who are online now.
        pub online: Vec<String>,
    }

    pub struct PersonRef {
        pub id: String,
    }

    pub struct DmMessageRef {
        pub id: Id,
        pub channel_id: Id,
    }

    pub struct SocialPresence {
        pub id: String,
        pub online: bool,
    }

    pub struct DmTyping {
        pub channel_id: Id,
        pub user_id: String,
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum RelationshipKind {
    Friend,
    /// You asked them.
    Outgoing,
    /// They asked you.
    Incoming,
    /// You blocked them.
    Blocked,
}

impl RelationshipKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RelationshipKind::Friend => "friend",
            RelationshipKind::Outgoing => "outgoing",
            RelationshipKind::Incoming => "incoming",
            RelationshipKind::Blocked => "blocked",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "friend" => RelationshipKind::Friend,
            "outgoing" => RelationshipKind::Outgoing,
            "incoming" => RelationshipKind::Incoming,
            "blocked" => RelationshipKind::Blocked,
            _ => return None,
        })
    }
}

/// Sent by branchr ID's gateway.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d", rename_all = "SCREAMING_SNAKE_CASE")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum SocialEvent {
    Ready(SocialReady),
    HeartbeatAck,
    RelationshipUpdate(Relationship),
    RelationshipRemove(PersonRef),
    PresenceUpdate(SocialPresence),
    /// A person's name or avatar changed.
    PersonUpdate(Person),
    DmChannelCreate(DmChannel),
    DmMessageCreate(DmMessage),
    DmMessageUpdate(DmMessage),
    DmMessageDelete(DmMessageRef),
    DmTyping(DmTyping),
}

/// Sent to branchr ID's gateway.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", content = "d", rename_all = "snake_case", rename_all_fields = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum SocialOp {
    Identify { token: String },
    Heartbeat,
    Typing { channel_id: Id },
    Ack { channel_id: Id, message_id: Id },
}
