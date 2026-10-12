//! Guild permissions: one bit each, combined from a member's roles and adjusted per channel
//! by overwrites, the way Discord does it.
//!
//! Bits stay below 31 so the web client can use JavaScript's 32-bit bitwise operators.
//! `packages/protocol/src/permissions.ts` mirrors this list (a test keeps them in step).

use crate::Id;

pub type Permissions = u64;

macro_rules! perms {
    ($($name:ident = $bit:literal),* $(,)?) => {
        $(pub const $name: Permissions = 1 << $bit;)*
        /// Every permission, by name, in bit order.
        pub const NAMED: &[(&str, Permissions)] = &[$((stringify!($name), $name)),*];
    };
}

perms! {
    VIEW_CHANNEL = 0,
    SEND_MESSAGES = 1,
    ATTACH_FILES = 2,
    ADD_REACTIONS = 3,
    USE_EXTERNAL_EMOTES = 4,
    MENTION_EVERYONE = 5,
    MANAGE_MESSAGES = 6,
    MANAGE_CHANNELS = 7,
    MANAGE_ROLES = 8,
    MANAGE_EMOTES = 9,
    MANAGE_GUILD = 10,
    KICK_MEMBERS = 11,
    BAN_MEMBERS = 12,
    CHANGE_NICKNAME = 13,
    MANAGE_NICKNAMES = 14,
    CONNECT = 15,
    SPEAK = 16,
    STREAM = 17,
    VIDEO = 18,
    MUTE_MEMBERS = 19,
    DEAFEN_MEMBERS = 20,
    MOVE_MEMBERS = 21,
    CREATE_INVITE = 22,
    ADMINISTRATOR = 23,
    VIEW_AUDIT_LOG = 24,
    EMBED_LINKS = 25,
    MANAGE_WEBHOOKS = 26,
}

pub const ALL: Permissions = (1 << 27) - 1;

/// What `@everyone` can do in a new server: talk, react, join voice, invite, and ping
/// @everyone/@here (owners can take that away).
pub const DEFAULT_EVERYONE: Permissions = VIEW_CHANNEL
    | SEND_MESSAGES
    | ATTACH_FILES
    | EMBED_LINKS
    | ADD_REACTIONS
    | USE_EXTERNAL_EMOTES
    | MENTION_EVERYONE
    | CHANGE_NICKNAME
    | CONNECT
    | SPEAK
    | STREAM
    | VIDEO
    | CREATE_INVITE;

/// Server-wide permissions: `@everyone` plus every role the member has. Owners and
/// administrators get everything.
pub fn base(is_owner: bool, everyone: Permissions, roles: impl IntoIterator<Item = Permissions>) -> Permissions {
    if is_owner {
        return ALL;
    }
    let p = roles.into_iter().fold(everyone, |acc, r| acc | r);
    if p & ADMINISTRATOR != 0 { ALL } else { p }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Role(Id),
    Member(Id),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overwrite {
    pub target: Target,
    pub allow: Permissions,
    pub deny: Permissions,
}

/// Permissions in one channel: `base` adjusted by the channel's overwrites, applied as
/// @everyone (the role whose id is the guild's), then the member's roles combined, then the
/// member themselves. Each step denies first, then allows.
pub fn in_channel(base: Permissions, guild: Id, member: Id, member_roles: &[Id], overwrites: &[Overwrite]) -> Permissions {
    if base & ADMINISTRATOR != 0 {
        return ALL;
    }
    let mut p = base;
    if let Some(o) = overwrites.iter().find(|o| o.target == Target::Role(guild)) {
        p = (p & !o.deny) | o.allow;
    }
    let (mut allow, mut deny) = (0, 0);
    for o in overwrites {
        if let Target::Role(r) = o.target
            && r != guild
            && member_roles.contains(&r)
        {
            allow |= o.allow;
            deny |= o.deny;
        }
    }
    p = (p & !deny) | allow;
    if let Some(o) = overwrites.iter().find(|o| o.target == Target::Member(member)) {
        p = (p & !o.deny) | o.allow;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: Id = Id(1);
    const ME: Id = Id(10);
    const MOD: Id = Id(100);
    const MUTED: Id = Id(101);

    fn role(id: Id, allow: Permissions, deny: Permissions) -> Overwrite {
        Overwrite { target: Target::Role(id), allow, deny }
    }

    #[test]
    fn base_combines_roles_and_admin_owner_get_all() {
        assert_eq!(base(false, VIEW_CHANNEL, [SEND_MESSAGES, KICK_MEMBERS]), VIEW_CHANNEL | SEND_MESSAGES | KICK_MEMBERS);
        assert_eq!(base(false, VIEW_CHANNEL, [ADMINISTRATOR]), ALL);
        assert_eq!(base(true, 0, []), ALL);
    }

    #[test]
    fn channel_overwrites_apply_in_order() {
        let b = DEFAULT_EVERYONE;
        // @everyone can't see a staff channel; the moderator role can.
        let staff = [role(G, 0, VIEW_CHANNEL), role(MOD, VIEW_CHANNEL, 0)];
        assert_eq!(in_channel(b, G, ME, &[], &staff) & VIEW_CHANNEL, 0);
        assert_ne!(in_channel(b, G, ME, &[MOD], &staff) & VIEW_CHANNEL, 0);
        // Role allows beat role denies at the same level.
        let mixed = [role(MOD, SEND_MESSAGES, 0), role(MUTED, 0, SEND_MESSAGES)];
        assert_ne!(in_channel(b, G, ME, &[MOD, MUTED], &mixed) & SEND_MESSAGES, 0);
        assert_eq!(in_channel(b, G, ME, &[MUTED], &mixed) & SEND_MESSAGES, 0);
        // A member overwrite beats every role.
        let personal = [role(MOD, SEND_MESSAGES, 0), Overwrite { target: Target::Member(ME), allow: 0, deny: SEND_MESSAGES }];
        assert_eq!(in_channel(b, G, ME, &[MOD], &personal) & SEND_MESSAGES, 0);
        // Administrators ignore overwrites.
        assert_eq!(in_channel(ALL, G, ME, &[], &staff), ALL);
    }

    #[test]
    fn bits_fit_javascript_and_match_the_client() {
        assert!(ALL < 1 << 31);
        assert_eq!(NAMED.iter().fold(0, |a, (_, p)| a | p), ALL);
        // The migrations hardcode these for existing servers.
        assert_eq!(DEFAULT_EVERYONE, 4694079 | EMBED_LINKS);
        assert_eq!(DEFAULT_EVERYONE & !MENTION_EVERYONE, 4694047 | EMBED_LINKS);
        let ts = include_str!("../../../packages/protocol/src/permissions.ts");
        for (i, (name, _)) in NAMED.iter().enumerate() {
            assert!(ts.contains(&format!("{name}: 1 << {i},")), "permissions.ts is missing {name} = 1 << {i}");
        }
    }
}
