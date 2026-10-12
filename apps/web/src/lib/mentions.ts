import type { Message, Role, User } from "@app/protocol";

import { P, has, permsOf } from "@/lib/perms";
import { type AppState, useApp } from "@/stores/app";

/**
 * Mentions as stored: `<@userId>`, `<@&roleId>`, and `@everyone` / `@here`. People type
 * `@username` (the server rewrites it to `<@id>`) and `@Role Name` (we rewrite it on send).
 */
export const USER_MENTION = /<@(\d+)>/;
export const ROLE_MENTION = /<@&(\d+)>/;
export const EVERYONE_MENTION = /(?<![\w<])@(everyone|here)\b/;

/** What a mentioned user is called in a guild: nick, then display name, then the snapshot. */
export function mentionName(guildId: string | undefined, id: string, snapshot?: User, s: AppState = useApp.getState()): string {
  const member = guildId ? s.members[guildId]?.[id] : undefined;
  return member?.nick ?? member?.user.displayName ?? snapshot?.displayName ?? "unknown-user";
}

/** Whether we may ping @everyone / @here in `guildId`. */
export function canMentionEveryone(guildId: string | undefined): boolean {
  return !guildId || has(permsOf(useApp.getState(), guildId), P.MENTION_EVERYONE);
}

/** Whether `m` pings us: by name, @everyone/@here, or a role we have. Our own messages never do. */
export function mentionsMe(m: Pick<Message, "author" | "channelId" | "mentions" | "mentionEveryone" | "mentionRoles">, s: AppState): boolean {
  const me = s.me?.id;
  if (!me || m.author.id === me) return false;
  if (m.mentionEveryone || m.mentions.some((u) => u.id === me)) return true;
  if (!m.mentionRoles.length) return false;
  const gid = s.channels[m.channelId]?.guildId;
  const mine = gid ? (s.members[gid]?.[me]?.roles ?? []) : [];
  return m.mentionRoles.some((r) => mine.includes(r));
}

/** A guild's roles that can be @mentioned (not @everyone), longest names first. */
function namedRoles(guildId: string | undefined, s: AppState): Role[] {
  if (!guildId) return [];
  return (s.roles[guildId] ?? []).filter((r) => r.id !== guildId).sort((a, b) => b.name.length - a.name.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `@Role Name` → `<@&id>` (names can have spaces, so the server can't find them itself). */
export function withRoleMentions(content: string, guildId: string | undefined, s: AppState = useApp.getState()): string {
  let out = content;
  // A member's username wins over a role of the same name.
  const usernames = new Set(Object.values(guildId ? (s.members[guildId] ?? {}) : {}).map((m) => m.user.username.toLowerCase()));
  for (const r of namedRoles(guildId, s)) {
    if (usernames.has(r.name.toLowerCase())) continue;
    out = out.replace(new RegExp(`(?<![\\w<])@${escapeRe(r.name)}(?![\\w])`, "gi"), `<@&${r.id}>`);
  }
  return out;
}

/** Roles in `content` that will ping: mentionable ones, or any if we may mention everyone. */
function pingedRoles(content: string, guildId: string | undefined, s: AppState): string[] {
  const ids = [...content.matchAll(new RegExp(ROLE_MENTION.source, "g"))].map((m) => m[1]);
  const roles = guildId ? (s.roles[guildId] ?? []) : [];
  const all = canMentionEveryone(guildId);
  return [...new Set(ids)].filter((id) => id !== guildId && roles.some((r) => r.id === id && (r.mentionable || all)));
}

export function roleName(guildId: string | undefined, id: string, s: AppState = useApp.getState()): string {
  return (guildId && s.roles[guildId]?.find((r) => r.id === id)?.name) || "deleted-role";
}

const NAME = /(?<![\w<])@([\w.]{2,32})/g;

/** Mirrors the server's `@username` → `<@id>` rewrite, for the optimistic copy of a send. */
export function localMentions(
  content: string,
  guildId: string | undefined,
): { content: string; mentions: User[]; mentionEveryone: boolean; mentionRoles: string[] } {
  const members = guildId ? useApp.getState().members[guildId] : undefined;
  const byName = new Map(Object.values(members ?? {}).map((m) => [m.user.username.toLowerCase(), m.user]));
  const mentions: User[] = [];
  const out = content.replace(NAME, (all, raw: string) => {
    const u = byName.get(raw.replace(/\.+$/, "").toLowerCase());
    if (!u) return all;
    if (!mentions.some((x) => x.id === u.id)) mentions.push(u);
    return `<@${u.id}>${raw.slice(u.username.length)}`;
  });
  return {
    content: out,
    mentions,
    mentionEveryone: EVERYONE_MENTION.test(content) && canMentionEveryone(guildId),
    mentionRoles: pingedRoles(out, guildId, useApp.getState()),
  };
}

/** `<@id>` → `@username` and `<@&id>` → `@Role Name`, for editing a message as it was typed. */
export function editableMentions(content: string, mentions: User[], guildId: string | undefined): string {
  return content
    .replace(new RegExp(USER_MENTION.source, "g"), (all, id: string) => {
      const u = mentions.find((x) => x.id === id);
      return u ? `@${u.username}` : all;
    })
    .replace(new RegExp(ROLE_MENTION.source, "g"), (all, id: string) => {
      const r = guildId ? useApp.getState().roles[guildId]?.find((x) => x.id === id) : undefined;
      return r ? `@${r.name}` : all;
    });
}

/** One line of plain text for previews and notifications. */
export function plainText(m: Pick<Message, "content" | "mentions">, guildId: string | undefined, s: AppState = useApp.getState()): string {
  return m.content
    .replace(new RegExp(USER_MENTION.source, "g"), (_, id: string) => `@${mentionName(guildId, id, m.mentions.find((u) => u.id === id), s)}`)
    .replace(new RegExp(ROLE_MENTION.source, "g"), (_, id: string) => `@${roleName(guildId, id, s)}`)
    .replace(/<:([\w!?-]+):\d+>/g, ":$1:")
    .replace(/\s+/g, " ")
    .trim();
}
