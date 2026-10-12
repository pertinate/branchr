/** What we (or anyone) may do in a guild, from its roles. The server enforces the same rules. */
import { type Role, P, basePerms, memberColor, topPosition } from "@app/protocol";

import { type AppState, useApp } from "@/stores/app";

export { P };

export function permsOf(s: AppState, guildId: string | undefined, userId = s.me?.id): number {
  const g = guildId ? s.guilds[guildId] : undefined;
  if (!g || !userId) return 0;
  return basePerms(g, s.roles[g.id] ?? [], s.members[g.id]?.[userId]);
}

export const has = (perms: number, p: number) => (perms & p) === p;

/** Whether we have every bit in `p` in `guildId`. */
export function useCan(guildId: string | undefined, p: number): boolean {
  return useApp((s) => has(permsOf(s, guildId), p));
}

/** Whether we have any of the bits in `p`. */
export function useCanAny(guildId: string | undefined, p: number): boolean {
  return useApp((s) => (permsOf(s, guildId) & p) !== 0);
}

export function topOf(s: AppState, guildId: string, userId: string | undefined): number {
  const g = s.guilds[guildId];
  if (!g || !userId) return -1;
  return topPosition(g, s.roles[guildId] ?? [], s.members[guildId]?.[userId]);
}

/** Whether we outrank `userId` (needed to kick them or change their roles). */
export function useOutranks(guildId: string, userId: string): boolean {
  return useApp((s) => {
    const g = s.guilds[guildId];
    if (!g || userId === g.ownerId) return false;
    return g.ownerId === s.me?.id || topOf(s, guildId, s.me?.id) > topOf(s, guildId, userId);
  });
}

/** Settings tabs that need a permission: any of these opens Server Settings. */
export const SETTINGS_PERMS = P.MANAGE_GUILD | P.MANAGE_ROLES;

export function roleColor(r: Pick<Role, "color">): string | undefined {
  return r.color == null ? undefined : `#${r.color.toString(16).padStart(6, "0")}`;
}

/** The colour of someone's highest coloured role in `guildId`, if any. */
export function useRoleColor(guildId: string | undefined, userId: string): string | undefined {
  return useApp((s) => (guildId ? memberColor(s.roles[guildId] ?? [], s.members[guildId]?.[userId]) : undefined));
}
