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
        /// Their branchr account, when they signed in with one (to befriend or message them).
        #[serde(default)]
        pub global_id: Option<String>,
        /// A webhook, not a person.
        #[serde(default)]
        pub bot: bool,
    }

    pub struct Guild {
        pub id: Id,
        pub name: String,
        pub icon_url: Option<String>,
        pub owner_id: Id,
        /// Shown above the channel list. Like `icon_url`, a path on this server when uploaded.
        pub banner_url: Option<String>,
        pub description: Option<String>,
        /// Where "X joined" messages go.
        pub system_channel_id: Option<Id>,
        /// A permanent invite code of the server's choosing.
        pub vanity_code: Option<String>,
        /// Listed in Explore (when the host is connected to branchr ID).
        pub discoverable: bool,
        /// For Explore: up to five, lowercase.
        pub tags: Vec<String>,
    }

    /// A guild role. `@everyone` is the role whose id is the guild's, at position 0.
    pub struct Role {
        pub id: Id,
        pub guild_id: Id,
        pub name: String,
        /// 0xRRGGBB, or none to leave names uncoloured.
        pub color: Option<u32>,
        /// Higher outranks lower.
        pub position: i32,
        /// Bits from `perms`.
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub permissions: u64,
        /// Listed separately in the member list.
        pub hoist: bool,
        /// Anyone can ping it with `<@&id>`.
        pub mentionable: bool,
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
        /// Per-channel permission changes for roles and members.
        pub overwrites: Vec<PermissionOverwrite>,
        /// Slow mode: seconds each member waits between messages (0 = off). People who can
        /// manage messages or the channel aren't held to it.
        #[serde(default)]
        pub slowmode_secs: u32,
        /// A thread's first message, in its parent channel (when started from one).
        #[serde(default)]
        pub starter_message_id: Option<Id>,
        /// Who started a thread.
        #[serde(default)]
        pub owner_id: Option<Id>,
    }

    /// Adjusts a role's or member's permissions in one channel: `deny` bits are taken
    /// away, then `allow` bits added. `id` is the role (the guild's id for @everyone) or user.
    pub struct PermissionOverwrite {
        pub id: Id,
        pub kind: OverwriteKind,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub allow: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub deny: u64,
    }

    pub struct Member {
        pub guild_id: Id,
        pub user: User,
        pub nick: Option<String>,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub joined_at: i64,
        /// Role ids, not including `@everyone`.
        pub roles: Vec<Id>,
    }

    pub struct Message {
        pub id: Id,
        pub channel_id: Id,
        /// Regular, or a system message (the author is who it's about).
        #[serde(default)]
        pub kind: MessageKind,
        pub author: User,
        pub content: String,
        #[cfg_attr(feature = "ts", ts(type = "number | null"))]
        pub edited_at: Option<i64>,
        /// Present when this message is a reply.
        pub reply_to: Option<Id>,
        pub reactions: Vec<Reaction>,
        #[serde(default)]
        pub attachments: Vec<Attachment>,
        /// Emotes referenced as `<:name:id>` in `content` (typically from other servers),
        /// snapshotted when sent so any reader can render them.
        #[serde(default)]
        pub emotes: Vec<Emote>,
        /// Users mentioned as `<@id>` (and the author replied to), snapshotted when sent.
        #[serde(default)]
        pub mentions: Vec<User>,
        /// `@everyone` or `@here`.
        #[serde(default)]
        pub mention_everyone: bool,
        /// Roles the message pinged (`<@&id>` of a mentionable role, or from someone allowed to
        /// mention everyone).
        pub mention_roles: Vec<Id>,
        /// Pinned to its channel.
        #[serde(default)]
        pub pinned: bool,
        /// Previews of links in `content`, filled in by the server shortly after sending.
        #[serde(default)]
        pub embeds: Vec<Embed>,
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
        /// A small preview for images too big to show as they are (same origin rule).
        pub thumb_url: Option<String>,
    }

    /// A link preview, from the page's OpenGraph tags (or the link itself, for an image).
    pub struct Embed {
        pub url: String,
        pub site_name: Option<String>,
        pub title: Option<String>,
        pub description: Option<String>,
        /// The page's picture, copied to this server (a same-origin path), so viewers never
        /// load anything from the linked site.
        pub image: Option<EmbedImage>,
        /// Show the picture full width under the text, rather than beside it.
        pub large: bool,
        /// The page's `theme-color`, as `#rrggbb`.
        pub color: Option<String>,
    }

    pub struct EmbedImage {
        pub url: String,
        pub width: u32,
        pub height: u32,
    }

    /// Posts into a channel from outside: `POST /api/webhooks/{id}/{token}` with `{"content"}`
    /// (and optionally `username` / `avatar_url` for that post).
    pub struct Webhook {
        /// Also the id its messages are authored by.
        pub id: Id,
        pub guild_id: Id,
        pub channel_id: Id,
        pub name: String,
        pub creator_id: Id,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub created_at: i64,
        /// Only in the reply that creates it or resets its token; it isn't stored readably.
        pub token: Option<String>,
    }

    pub struct Reaction {
        /// Unicode emoji, or `e:<emoteId>` for a guild emote.
        pub emoji: String,
        pub count: u32,
        /// Whether the requesting user reacted. Only meaningful in REST responses;
        /// gateway clients track their own reactions.
        pub me: bool,
    }

    /// A third-party emote (7TV, BetterTTV, FrankerFaceZ) added to a guild.
    /// Images are loaded from the provider's CDN using `providerId`.
    pub struct Emote {
        pub id: Id,
        pub guild_id: Id,
        pub name: String,
        pub provider: EmoteProvider,
        pub provider_id: String,
        pub animated: bool,
        pub width: u32,
        pub height: u32,
    }

    pub struct Invite {
        pub code: String,
        pub guild_id: Id,
        pub guild_name: String,
        pub guild_icon_url: Option<String>,
        pub member_count: u32,
        /// When it stops working (ms), if it does.
        #[cfg_attr(feature = "ts", ts(type = "number | null"))]
        pub expires_at: Option<i64>,
        pub max_uses: Option<u32>,
        pub uses: u32,
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
        /// Their custom status ("back at 5"), if set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub custom: Option<String>,
    }

    /// An emote found on a provider (not yet added to a guild).
    pub struct ExternalEmote {
        pub provider: EmoteProvider,
        pub id: String,
        pub name: String,
        pub animated: bool,
        pub width: u32,
        pub height: u32,
        pub owner: Option<String>,
    }

    /// Result of importing a set or channel: what was added, out of how many found
    /// (the rest had invalid or already-used names, or hit the emote limit).
    pub struct EmoteImport {
        pub added: Vec<Emote>,
        pub found: u32,
    }

    pub struct AuthResponse {
        pub token: String,
        pub user: User,
    }

    /// A host at a glance, for its owner (`GET /api/admin/overview`).
    pub struct HostOverview {
        pub name: String,
        pub auth_mode: String,
        pub open_registration: bool,
        pub users: u32,
        pub banned: u32,
        pub guilds: u32,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub messages: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub attachment_bytes: u64,
        /// What you may do here.
        pub my_role: HostRole,
        /// Largest attachment, in MB (owner-adjustable; starts from MAX_UPLOAD_MB).
        #[serde(default)]
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub max_upload_mb: u64,
        /// Whether each voice server answers, checked when the overview loads.
        #[serde(default)]
        pub sfus: Vec<SfuHealth>,
    }

    pub struct SfuHealth {
        /// Its signaling address, as clients get it.
        pub url: String,
        pub ok: bool,
        /// Round trip of its health check.
        pub ms: Option<u32>,
        /// Where clients send it media, and how it found that (its /status).
        #[serde(default)]
        pub public_ip: Option<String>,
        #[serde(default)]
        pub lan_ip: Option<String>,
        #[serde(default)]
        pub ports: Vec<u16>,
        /// "fixed", "upnp" or "echo".
        #[serde(default)]
        pub via: Option<String>,
        /// The router forwarded its ports (UPnP).
        #[serde(default)]
        pub forwarded: bool,
        #[serde(default)]
        pub warning: Option<String>,
        /// Which ports answered branchr ID's probe from the internet (checked for hubs that
        /// find their own address); none if not checked.
        #[serde(default)]
        pub reachable: Option<Vec<u16>>,
    }

    /// A user on the host, for its owner.
    pub struct HostUser {
        pub user: User,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub created_at: i64,
        /// Signed in with (or linked to) a branchr account.
        pub linked: bool,
        /// The host's owner (can't be banned).
        pub owner: bool,
        /// Their staff role, if any (the owner's is `owner`).
        pub role: Option<HostRole>,
        pub guilds: u32,
        pub banned: bool,
        pub ban_reason: Option<String>,
    }

    /// A server (guild) on the host, for its owner.
    pub struct HostGuild {
        pub guild: Guild,
        pub owner: User,
        pub members: u32,
        pub channels: u32,
    }

    /// How to log in to this server (`GET /api/instance`).
    pub struct InstanceInfo {
        /// `local` (own accounts), `federated` (branchr accounts) or `both`.
        pub auth_mode: String,
        /// The branchr ID this server accepts accounts from, if any.
        pub branchr_id_url: Option<String>,
        /// This server's id at branchr ID, once registered (passes are issued for it).
        pub instance_id: Option<String>,
        /// Whether an owner has claimed it at branchr ID.
        pub claimed: bool,
        /// What people see it called (INSTANCE_NAME); its key above is what tells hubs apart.
        #[serde(default)]
        pub name: String,
    }

    pub struct VoiceServer {
        /// WebSocket url of the SFU for this channel.
        pub endpoint: String,
        pub token: String,
        pub guild_id: Id,
        pub channel_id: Id,
    }

    /// Someone banned from a guild.
    pub struct GuildBan {
        pub user: User,
        pub reason: Option<String>,
        pub banned_by: Option<Id>,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        pub created_at: i64,
    }

    /// One change in an audit log entry, as text (`None` when it didn't exist).
    pub struct AuditChange {
        pub key: String,
        pub old: Option<String>,
        pub new: Option<String>,
    }

    pub struct AuditEntry {
        /// Also when it happened (a snowflake).
        pub id: Id,
        pub actor_id: Id,
        pub action: AuditAction,
        pub target_id: Option<Id>,
        /// The target's name at the time (it may since have been renamed or deleted).
        pub target_name: Option<String>,
        pub changes: Vec<AuditChange>,
        pub reason: Option<String>,
    }

    /// A page of the audit log, with everyone it mentions (including people who left).
    pub struct AuditLog {
        pub entries: Vec<AuditEntry>,
        pub users: Vec<User>,
    }

    pub struct ApiError {
        pub error: String,
    }
}

/// Who runs a host, highest first: the owner (who claimed it) appoints admins and moderators.
/// Admins change settings and remove servers; moderators ban people.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum HostRole {
    Moderator,
    Admin,
    Owner,
}

impl HostRole {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(HostRole::Admin),
            "moderator" => Some(HostRole::Moderator),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            HostRole::Owner => "owner",
            HostRole::Admin => "admin",
            HostRole::Moderator => "moderator",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum MessageKind {
    #[default]
    Default,
    MemberJoin,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MessageKind::Default => "default",
            MessageKind::MemberJoin => "member_join",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "member_join" { MessageKind::MemberJoin } else { MessageKind::Default }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum AuditAction {
    GuildUpdate,
    ChannelCreate,
    ChannelUpdate,
    ChannelDelete,
    ChannelOverwriteUpdate,
    ChannelOverwriteDelete,
    MemberKick,
    MemberBanAdd,
    MemberBanRemove,
    MemberRoleAdd,
    MemberRoleRemove,
    RoleCreate,
    RoleUpdate,
    RoleDelete,
    EmoteCreate,
    EmoteUpdate,
    EmoteDelete,
    MessageDelete,
    WebhookCreate,
    WebhookUpdate,
    WebhookDelete,
}

impl AuditAction {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditAction::GuildUpdate => "guild_update",
            AuditAction::ChannelCreate => "channel_create",
            AuditAction::ChannelUpdate => "channel_update",
            AuditAction::ChannelDelete => "channel_delete",
            AuditAction::ChannelOverwriteUpdate => "channel_overwrite_update",
            AuditAction::ChannelOverwriteDelete => "channel_overwrite_delete",
            AuditAction::MemberKick => "member_kick",
            AuditAction::MemberBanAdd => "member_ban_add",
            AuditAction::MemberBanRemove => "member_ban_remove",
            AuditAction::MemberRoleAdd => "member_role_add",
            AuditAction::MemberRoleRemove => "member_role_remove",
            AuditAction::RoleCreate => "role_create",
            AuditAction::RoleUpdate => "role_update",
            AuditAction::RoleDelete => "role_delete",
            AuditAction::EmoteCreate => "emote_create",
            AuditAction::EmoteUpdate => "emote_update",
            AuditAction::EmoteDelete => "emote_delete",
            AuditAction::MessageDelete => "message_delete",
            AuditAction::WebhookCreate => "webhook_create",
            AuditAction::WebhookUpdate => "webhook_update",
            AuditAction::WebhookDelete => "webhook_delete",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        serde_json::from_value(serde_json::Value::String(s.to_owned())).ok()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum OverwriteKind {
    Role,
    Member,
}

impl OverwriteKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OverwriteKind::Role => "role",
            OverwriteKind::Member => "member",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum ChannelKind {
    Text,
    Voice,
    Category,
    /// A side conversation under a text channel (its `parent_id`).
    Thread,
}

impl ChannelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Voice => "voice",
            Self::Category => "category",
            Self::Thread => "thread",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "text" => Self::Text,
            "voice" => Self::Voice,
            "category" => Self::Category,
            "thread" => Self::Thread,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum EmoteProvider {
    #[serde(rename = "7tv")]
    SevenTv,
    #[serde(rename = "bttv")]
    Bttv,
    #[serde(rename = "ffz")]
    Ffz,
}

impl EmoteProvider {
    pub const ALL: [Self; 3] = [Self::SevenTv, Self::Bttv, Self::Ffz];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SevenTv => "7tv",
            Self::Bttv => "bttv",
            Self::Ffz => "ffz",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == s)
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
