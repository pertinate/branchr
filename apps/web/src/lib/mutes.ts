/**
 * Muted communities and channels, and how much each community notifies. Kept on this device,
 * like the rail layout. Muting hides unread markers; mentions still count and notify (unless
 * the community is set to notify about nothing), as on Discord.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { type GuildRef, guildRef } from "@/lib/rail-layout";

/** What notifies: every message, only mentions of you (the default), or nothing. */
export type NotifyLevel = "all" | "mentions" | "nothing";

/** `instanceId/channelId`: channel ids are only unique per host. */
const channelRef = (instanceId: string, channelId: string) => `${instanceId}/${channelId}`;

interface Mutes {
  guilds: Record<GuildRef, true>;
  channels: Record<string, true>;
  levels: Record<GuildRef, NotifyLevel>;
  muteGuild: (instanceId: string, guildId: string, muted: boolean) => void;
  muteChannel: (instanceId: string, channelId: string, muted: boolean) => void;
  setLevel: (instanceId: string, guildId: string, level: NotifyLevel) => void;
}

function toggled<T extends Record<string, true>>(map: T, key: string, on: boolean): T {
  const next = { ...map } as Record<string, true>;
  if (on) next[key] = true;
  else delete next[key];
  return next as T;
}

export const useMutes = create<Mutes>()(
  persist(
    (set) => ({
      guilds: {},
      channels: {},
      levels: {},
      muteGuild: (instanceId, guildId, muted) => set((s) => ({ guilds: toggled(s.guilds, guildRef(instanceId, guildId), muted) })),
      muteChannel: (instanceId, channelId, muted) => set((s) => ({ channels: toggled(s.channels, channelRef(instanceId, channelId), muted) })),
      setLevel: (instanceId, guildId, level) =>
        set((s) => {
          const levels = { ...s.levels };
          if (level === "mentions") delete levels[guildRef(instanceId, guildId)];
          else levels[guildRef(instanceId, guildId)] = level;
          return { levels };
        }),
    }),
    { name: "mutes", version: 1, partialize: ({ guilds, channels, levels }) => ({ guilds, channels, levels }) },
  ),
);

export const guildMuted = (m: Pick<Mutes, "guilds">, instanceId: string, guildId: string) => !!m.guilds[guildRef(instanceId, guildId)];
export const channelMuted = (m: Pick<Mutes, "channels">, instanceId: string, channelId: string) => !!m.channels[channelRef(instanceId, channelId)];
export const notifyLevel = (m: Pick<Mutes, "levels">, instanceId: string, guildId: string): NotifyLevel => m.levels[guildRef(instanceId, guildId)] ?? "mentions";

export const useGuildMuted = (instanceId: string, guildId: string) => useMutes((m) => guildMuted(m, instanceId, guildId));
export const useChannelMuted = (instanceId: string, channelId: string) => useMutes((m) => channelMuted(m, instanceId, channelId));
