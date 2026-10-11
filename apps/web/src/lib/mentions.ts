import type { Message, User } from "@app/protocol";

import { useApp } from "@/stores/app";

/**
 * Mentions as stored: `<@userId>`, `<@&roleId>` (roles, not implemented yet), and
 * `@everyone` / `@here`. People type `@username`; the server rewrites it to `<@id>`.
 */
export const USER_MENTION = /<@(\d+)>/;
export const ROLE_MENTION = /<@&(\d+)>/;
export const EVERYONE_MENTION = /(?<![\w<])@(everyone|here)\b/;

/** What a mentioned user is called in a guild: nick, then display name, then the snapshot. */
export function mentionName(guildId: string | undefined, id: string, snapshot?: User): string {
  const s = useApp.getState();
  const member = guildId ? s.members[guildId]?.[id] : undefined;
  return member?.nick ?? member?.user.displayName ?? snapshot?.displayName ?? "unknown-user";
}

/** Whether we may ping @everyone / @here in `guildId`. */
export function canMentionEveryone(guildId: string | undefined): boolean {
  const s = useApp.getState();
  const g = guildId ? s.guilds[guildId] : undefined;
  return !g || g.everyoneMentions || g.ownerId === s.me?.id;
}

/** Whether `m` should ping `me`. Your own messages never do. */
export function mentionsMe(m: Pick<Message, "author" | "mentions" | "mentionEveryone">, me: string | undefined): boolean {
  if (!me || m.author.id === me) return false;
  return m.mentionEveryone || m.mentions.some((u) => u.id === me);
}

const NAME = /(?<![\w<])@([\w.]{2,32})/g;

/** Mirrors the server's `@username` → `<@id>` rewrite, for the optimistic copy of a send. */
export function localMentions(content: string, guildId: string | undefined): { content: string; mentions: User[]; mentionEveryone: boolean } {
  const members = guildId ? useApp.getState().members[guildId] : undefined;
  const byName = new Map(Object.values(members ?? {}).map((m) => [m.user.username.toLowerCase(), m.user]));
  const mentions: User[] = [];
  const out = content.replace(NAME, (all, raw: string) => {
    const u = byName.get(raw.replace(/\.+$/, "").toLowerCase());
    if (!u) return all;
    if (!mentions.some((x) => x.id === u.id)) mentions.push(u);
    return `<@${u.id}>${raw.slice(u.username.length)}`;
  });
  return { content: out, mentions, mentionEveryone: EVERYONE_MENTION.test(content) && canMentionEveryone(guildId) };
}

/** `<@id>` → `@username`, for editing a message as it was typed. */
export function editableMentions(content: string, mentions: User[]): string {
  return content.replace(new RegExp(USER_MENTION.source, "g"), (all, id: string) => {
    const u = mentions.find((x) => x.id === id);
    return u ? `@${u.username}` : all;
  });
}

/** One line of plain text for previews and notifications. */
export function plainText(m: Pick<Message, "content" | "mentions">, guildId: string | undefined): string {
  return m.content
    .replace(new RegExp(USER_MENTION.source, "g"), (_, id: string) => `@${mentionName(guildId, id, m.mentions.find((u) => u.id === id))}`)
    .replace(new RegExp(ROLE_MENTION.source, "g"), "@unknown-role")
    .replace(/<:([\w!?-]+):\d+>/g, ":$1:")
    .replace(/\s+/g, " ")
    .trim();
}
