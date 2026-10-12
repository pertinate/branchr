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
        /// One-to-one, or a group.
        pub group: bool,
        /// A group's name, if it has one (otherwise show the members' names).
        pub name: Option<String>,
        /// Who can add and remove people in a group.
        pub owner_id: Option<String>,
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
        /// Calls going on in your conversations.
        pub calls: Vec<CallState>,
    }

    /// Someone in a call, with the id the SFU knows them by.
    pub struct CallParticipant {
        pub id: String,
        pub voice_id: Id,
    }

    /// A conversation's call. No participants means it ended.
    pub struct CallState {
        pub channel_id: Id,
        pub participants: Vec<CallParticipant>,
        /// Account ids being rung (they haven't joined or declined yet).
        pub ringing: Vec<String>,
    }

    /// Where to connect for a call.
    pub struct CallJoin {
        pub endpoint: String,
        pub token: String,
        /// The id the SFU knows you by.
        pub voice_id: Id,
    }

    pub struct PersonRef {
        pub id: String,
    }

    pub struct DmChannelRef {
        pub id: Id,
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
    /// A conversation appeared or changed (members, name, read position).
    DmChannelCreate(DmChannel),
    /// You left (or were removed from) a group.
    DmChannelDelete(DmChannelRef),
    DmMessageCreate(DmMessage),
    DmMessageUpdate(DmMessage),
    DmMessageDelete(DmMessageRef),
    DmTyping(DmTyping),
    CallUpdate(CallState),
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

wire! {
    /// A server a host publishes for people to find (from the host to branchr ID).
    pub struct PublishedServer {
        /// The guild's id on its host.
        pub guild_id: Id,
        pub name: String,
        pub description: Option<String>,
        /// Absolute.
        pub icon_url: Option<String>,
        pub tags: Vec<String>,
        pub members: u32,
        pub online: u32,
        /// A permanent invite code on that host.
        pub invite: String,
    }

    /// A server in Explore.
    pub struct Listing {
        pub server: PublishedServer,
        /// The host's address, which the invite is for.
        pub host_url: String,
        pub host_name: String,
    }
}
