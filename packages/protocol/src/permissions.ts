/**
 * Guild permission bits, mirroring crates/proto/src/perms.rs (a Rust test checks they match).
 * All below bit 31, so plain `&` / `|` work.
 */
import type { Channel } from "./generated/Channel";
import type { Guild } from "./generated/Guild";
import type { Member } from "./generated/Member";
import type { Role } from "./generated/Role";

export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  ATTACH_FILES: 1 << 2,
  ADD_REACTIONS: 1 << 3,
  USE_EXTERNAL_EMOTES: 1 << 4,
  MENTION_EVERYONE: 1 << 5,
  MANAGE_MESSAGES: 1 << 6,
  MANAGE_CHANNELS: 1 << 7,
  MANAGE_ROLES: 1 << 8,
  MANAGE_EMOTES: 1 << 9,
  MANAGE_GUILD: 1 << 10,
  KICK_MEMBERS: 1 << 11,
  BAN_MEMBERS: 1 << 12,
  CHANGE_NICKNAME: 1 << 13,
  MANAGE_NICKNAMES: 1 << 14,
  CONNECT: 1 << 15,
  SPEAK: 1 << 16,
  STREAM: 1 << 17,
  VIDEO: 1 << 18,
  MUTE_MEMBERS: 1 << 19,
  DEAFEN_MEMBERS: 1 << 20,
  MOVE_MEMBERS: 1 << 21,
  CREATE_INVITE: 1 << 22,
  ADMINISTRATOR: 1 << 23,
  VIEW_AUDIT_LOG: 1 << 24,
} as const;

export type Perm = keyof typeof P;

export const ALL_PERMS = (1 << 25) - 1;

/** For settings screens, grouped as Discord does. */
export const PERM_GROUPS: { title: string; perms: { perm: Perm; label: string; hint: string }[] }[] = [
  {
    title: "General",
    perms: [
      { perm: "VIEW_CHANNEL", label: "View Channels", hint: "See channels and read their messages." },
      { perm: "MANAGE_CHANNELS", label: "Manage Channels", hint: "Create, edit and delete channels." },
      { perm: "MANAGE_ROLES", label: "Manage Roles", hint: "Create and edit roles below their highest role, and give them to people." },
      { perm: "MANAGE_EMOTES", label: "Manage Emotes", hint: "Add, rename and remove the server's emotes." },
      { perm: "MANAGE_GUILD", label: "Manage Server", hint: "Change the server's name and icon." },
      { perm: "CREATE_INVITE", label: "Create Invite", hint: "Invite new people." },
      { perm: "CHANGE_NICKNAME", label: "Change Nickname", hint: "Change their own nickname." },
      { perm: "MANAGE_NICKNAMES", label: "Manage Nicknames", hint: "Change other people's nicknames." },
      { perm: "KICK_MEMBERS", label: "Kick Members", hint: "Remove people below their highest role." },
      { perm: "BAN_MEMBERS", label: "Ban Members", hint: "Ban people below their highest role." },
      { perm: "VIEW_AUDIT_LOG", label: "View Audit Log", hint: "See who changed what in the server." },
    ],
  },
  {
    title: "Text",
    perms: [
      { perm: "SEND_MESSAGES", label: "Send Messages", hint: "Post in text channels." },
      { perm: "ATTACH_FILES", label: "Attach Files", hint: "Upload files and images." },
      { perm: "ADD_REACTIONS", label: "Add Reactions", hint: "React to messages." },
      { perm: "USE_EXTERNAL_EMOTES", label: "Use External Emotes", hint: "Use emotes from other servers." },
      { perm: "MENTION_EVERYONE", label: "Mention @everyone and @here", hint: "Ping everyone in a channel at once." },
      { perm: "MANAGE_MESSAGES", label: "Manage Messages", hint: "Delete other people's messages." },
    ],
  },
  {
    title: "Voice",
    perms: [
      { perm: "CONNECT", label: "Connect", hint: "Join voice channels." },
      { perm: "SPEAK", label: "Speak", hint: "Talk in voice channels." },
      { perm: "VIDEO", label: "Video", hint: "Turn on their camera." },
      { perm: "STREAM", label: "Stream", hint: "Share their screen." },
      { perm: "MUTE_MEMBERS", label: "Mute Members", hint: "Mute others in voice." },
      { perm: "DEAFEN_MEMBERS", label: "Deafen Members", hint: "Deafen others in voice." },
      { perm: "MOVE_MEMBERS", label: "Move Members", hint: "Move others between voice channels." },
    ],
  },
  {
    title: "Advanced",
    perms: [{ perm: "ADMINISTRATOR", label: "Administrator", hint: "Every permission, in every channel. Give it carefully." }],
  },
];

/** A member's server-wide permissions (no channel overwrites). */
export function basePerms(guild: Guild, roles: Role[], member: Pick<Member, "user" | "roles"> | undefined): number {
  if (!member) return 0;
  if (guild.ownerId === member.user.id) return ALL_PERMS;
  let p = 0;
  for (const r of roles) if (r.id === guild.id || member.roles.includes(r.id)) p |= r.permissions;
  return p & P.ADMINISTRATOR ? ALL_PERMS : p;
}

/** The member's highest role position (owners outrank everyone). */
export function topPosition(guild: Guild, roles: Role[], member: Pick<Member, "user" | "roles"> | undefined): number {
  if (!member) return -1;
  if (guild.ownerId === member.user.id) return Number.MAX_SAFE_INTEGER;
  let top = 0;
  for (const r of roles) if (member.roles.includes(r.id)) top = Math.max(top, r.position);
  return top;
}

/** Roles shown in a member's colour: the highest one with a colour. */
export function memberColor(roles: Role[], member: Pick<Member, "roles"> | undefined): string | undefined {
  if (!member?.roles.length) return undefined;
  let best: Role | undefined;
  for (const r of roles) if (r.color != null && member.roles.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best ? `#${best.color!.toString(16).padStart(6, "0")}` : undefined;
}

/**
 * Permissions in one channel: `base` adjusted by its overwrites — @everyone, then the member's
 * roles combined, then the member — each denying first, then allowing. Mirrors perms::in_channel.
 */
export function channelPerms(base: number, guild: Guild, member: Pick<Member, "user" | "roles"> | undefined, channel: Pick<Channel, "overwrites">): number {
  if (!member) return 0;
  if (base & P.ADMINISTRATOR) return ALL_PERMS;
  let p = base;
  const everyone = channel.overwrites.find((o) => o.kind === "role" && o.id === guild.id);
  if (everyone) p = (p & ~everyone.deny) | everyone.allow;
  let allow = 0;
  let deny = 0;
  for (const o of channel.overwrites) {
    if (o.kind === "role" && o.id !== guild.id && member.roles.includes(o.id)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  p = (p & ~deny) | allow;
  const mine = channel.overwrites.find((o) => o.kind === "member" && o.id === member.user.id);
  if (mine) p = (p & ~mine.deny) | mine.allow;
  return p;
}
