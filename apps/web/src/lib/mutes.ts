/**
 * Muted communities and channels, and how much each community notifies. Each hub keeps yours
 * for its communities (so they follow you across devices); this device keeps a copy. Muting
 * hides unread markers; mentions still count and notify (unless the community is set to
 * notify about nothing), as on Discord.
 */
import type { NotifyLevel, NotifySettings } from "@app/protocol";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { instance } from "@/lib/instances";
import { type GuildRef, guildRef, parseRef } from "@/lib/rail-layout";

export type { NotifyLevel };

/** `instanceId/channelId`: channel ids are only unique per host. */
const channelRef = (instanceId: string, channelId: string) => `${instanceId}/${channelId}`;

interface Mutes {
  guilds: Record<GuildRef, true>;
  channels: Record<string, true>;
  levels: Record<GuildRef, NotifyLevel>;
  /** Hubs with changes made here that haven't reached them yet (kept across reloads). */
  unsaved: Record<string, true>;
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
      unsaved: {},
      muteGuild: (instanceId, guildId, muted) => {
        set((s) => ({ guilds: toggled(s.guilds, guildRef(instanceId, guildId), muted) }));
        save(instanceId);
      },
      muteChannel: (instanceId, channelId, muted) => {
        set((s) => ({ channels: toggled(s.channels, channelRef(instanceId, channelId), muted) }));
        save(instanceId);
      },
      setLevel: (instanceId, guildId, level) => {
        set((s) => {
          const levels = { ...s.levels };
          if (level === "mentions") delete levels[guildRef(instanceId, guildId)];
          else levels[guildRef(instanceId, guildId)] = level;
          return { levels };
        });
        save(instanceId);
      },
    }),
    { name: "mutes", version: 1, partialize: ({ guilds, channels, levels, unsaved }) => ({ guilds, channels, levels, unsaved }) },
  ),
);

export const guildMuted = (m: Pick<Mutes, "guilds">, instanceId: string, guildId: string) => !!m.guilds[guildRef(instanceId, guildId)];
export const channelMuted = (m: Pick<Mutes, "channels">, instanceId: string, channelId: string) => !!m.channels[channelRef(instanceId, channelId)];
export const notifyLevel = (m: Pick<Mutes, "levels">, instanceId: string, guildId: string): NotifyLevel => m.levels[guildRef(instanceId, guildId)] ?? "mentions";

export const useGuildMuted = (instanceId: string, guildId: string) => useMutes((m) => guildMuted(m, instanceId, guildId));
export const useChannelMuted = (instanceId: string, channelId: string) => useMutes((m) => channelMuted(m, instanceId, channelId));

/** Keys of `map` on `instanceId`, as ids there. */
function idsOn<T>(map: Record<string, T>, instanceId: string): [string, T][] {
  return Object.entries(map).flatMap(([key, v]) => {
    const { instanceId: on, guildId: id } = parseRef(key);
    return on === instanceId ? [[id, v] as [string, T]] : [];
  });
}

/** What this device has for one hub. */
function settingsFor(instanceId: string): NotifySettings {
  const m = useMutes.getState();
  return {
    mutedGuilds: idsOn(m.guilds, instanceId).map(([id]) => id),
    mutedChannels: idsOn(m.channels, instanceId).map(([id]) => id),
    levels: idsOn(m.levels, instanceId).map(([guildId, level]) => ({ guildId, level })),
  };
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Saves one hub's settings there, shortly (toggling a few in a row is one save). Until it's
 * through, the hub's copy doesn't replace ours, even after a reload.
 */
function save(instanceId: string) {
  useMutes.setState((m) => ({ unsaved: { ...m.unsaved, [instanceId]: true } }));
  clearTimeout(pending.get(instanceId));
  pending.set(
    instanceId,
    setTimeout(() => {
      pending.delete(instanceId);
      const inst = instance(instanceId);
      if (!inst) return;
      inst
        .api("PUT", "/users/@me/notify-settings", settingsFor(instanceId))
        .then(() => {
          if (pending.has(instanceId)) return;
          useMutes.setState((m) => {
            const { [instanceId]: _, ...unsaved } = m.unsaved;
            return { unsaved };
          });
        })
        .catch(() => {});
    }, 300),
  );
}

/** This device's copy for one hub becomes `n`. */
function replaceFor(instanceId: string, n: NotifySettings) {
  const others = <T,>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([k]) => parseRef(k).instanceId !== instanceId));
  useMutes.setState((m) => ({
    guilds: { ...others(m.guilds), ...Object.fromEntries(n.mutedGuilds.map((g) => [guildRef(instanceId, g), true as const])) },
    channels: { ...others(m.channels), ...Object.fromEntries(n.mutedChannels.map((c) => [channelRef(instanceId, c), true as const])) },
    levels: { ...others(m.levels), ...Object.fromEntries(n.levels.map((l) => [guildRef(instanceId, l.guildId), l.level])) },
  }));
}

/**
 * On connecting: the hub's copy replaces ours, unless we have changes it hasn't got (made
 * just before a reload, or offline), or it has never had any; then it gets ours.
 */
export function fromHubReady(instanceId: string, n: NotifySettings | null) {
  if (pending.has(instanceId)) return;
  if (useMutes.getState().unsaved[instanceId]) return save(instanceId);
  if (n) return replaceFor(instanceId, n);
  const local = settingsFor(instanceId);
  if (local.mutedGuilds.length || local.mutedChannels.length || local.levels.length) save(instanceId);
}

/**
 * Changed on another device (or the echo of our own save). Never saves in turn: while ours
 * is on its way, ours wins.
 */
export function fromHubUpdate(instanceId: string, n: NotifySettings) {
  if (pending.has(instanceId) || useMutes.getState().unsaved[instanceId]) return;
  replaceFor(instanceId, n);
}
