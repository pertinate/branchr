import type {
  Channel,
  Emote,
  Guild,
  Member,
  ReadyGuild,
  Role,
  ServerEvent,
  Status,
  User,
  VoiceServer,
  VoiceState,
} from "@app/protocol";
import { create } from "zustand";

import { compareIds } from "@/lib/ids";
import { type Instance, instanceStore } from "@/lib/instances";
import { mentionsMe } from "@/lib/mentions";

export type ConnectionState = "idle" | "connecting" | "ready" | "reconnecting";

export interface AppState {
  connection: ConnectionState;
  me: User | null;
  guildOrder: string[];
  guilds: Record<string, Guild>;
  channels: Record<string, Channel>;
  /** guild id -> user id -> member */
  members: Record<string, Record<string, Member>>;
  presences: Record<string, Status>;
  /** guild id -> user id -> voice state */
  voice: Record<string, Record<string, VoiceState>>;
  emotes: Record<string, Emote[]>;
  /** guild id -> roles, lowest first (@everyone at 0) */
  roles: Record<string, Role[]>;
  /** channel id -> user id -> expiry timestamp */
  typing: Record<string, Record<string, number>>;
  /** Pending voice server handoff for our own join. */
  voiceServer: VoiceServer | null;
  /** channel id -> last message id we've seen */
  lastRead: Record<string, string>;
  /** Largest attachment the server accepts. */
  maxUploadBytes: number;
  /** channel id -> unread mentions of us (kept by the server) */
  pings: Record<string, number>;
  /** The text channel on screen, if any. */
  viewing: string | null;
  setViewing: (channelId: string | null) => void;
  setConnection: (c: ConnectionState) => void;
  markRead: (channelId: string) => void;
  apply: (ev: ServerEvent) => void;
}

function load<T>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
function save(key: string, v: unknown) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage full or unavailable */
    }
  }, 500);
}
const later = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : compareIds(a, b) >= 0 ? a : b);

function withGuild(s: AppState, rg: ReadyGuild): Partial<AppState> {
  const gid = rg.guild.id;
  const channels = { ...s.channels };
  for (const c of rg.channels) channels[c.id] = c;
  const members: Record<string, Member> = {};
  for (const m of rg.members) members[m.user.id] = m;
  const voice: Record<string, VoiceState> = {};
  for (const v of rg.voiceStates) voice[v.userId] = v;
  const presences = { ...s.presences };
  for (const p of rg.presences) presences[p.userId] = p.status;
  return {
    guilds: { ...s.guilds, [gid]: rg.guild },
    guildOrder: s.guildOrder.includes(gid) ? s.guildOrder : [...s.guildOrder, gid],
    channels,
    members: { ...s.members, [gid]: members },
    voice: { ...s.voice, [gid]: voice },
    emotes: { ...s.emotes, [gid]: rg.emotes },
    roles: { ...s.roles, [gid]: sortRoles(rg.roles) },
    presences,
  };
}

const sortRoles = (roles: Role[]) => [...roles].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _, ...rest } = rec;
  return rest;
}

function updateUserEverywhere(s: AppState, u: User): Partial<AppState> {
  const members = { ...s.members };
  for (const gid of Object.keys(members)) {
    const m = members[gid][u.id];
    if (m) members[gid] = { ...members[gid], [u.id]: { ...m, user: u } };
  }
  return { members, me: s.me?.id === u.id ? u : s.me };
}

/** One instance's state, fed by its gateway. */
export function createAppStore(inst: Instance) {
  // Read positions are per instance (ids are only unique within one).
  const LAST_READ_KEY = `lastRead:${inst.id}`;
  const saveLastRead = (v: Record<string, string>) => save(LAST_READ_KEY, v);
  const store = create<AppState>()((set, get) => ({
  connection: "idle",
  me: null,
  guildOrder: [],
  guilds: {},
  channels: {},
  members: {},
  presences: {},
  voice: {},
  emotes: {},
  roles: {},
  typing: {},
  voiceServer: null,
  lastRead: load(LAST_READ_KEY),
  maxUploadBytes: Infinity,
  pings: {},
  viewing: null,
  setViewing: (viewing) => set({ viewing }),
  setConnection: (connection) => set({ connection }),
  markRead: (channelId) => {
    // Not while the window is hidden (minimized, in the tray): nobody's reading.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const s = get();
    const last = s.channels[channelId]?.lastMessageId;
    if (!last || (s.lastRead[channelId] === last && !s.pings[channelId])) return;
    const lastRead = { ...s.lastRead, [channelId]: last };
    saveLastRead(lastRead);
    set({ lastRead, pings: without(s.pings, channelId) });
    // Synced so other devices and the next login agree.
    inst.gateway.send({ op: "ack", d: { channelId, messageId: last } });
  },
  apply: (ev) => {
    switch (ev.t) {
      case "READY": {
        const base: AppState = {
          ...get(),
          me: ev.d.user,
          maxUploadBytes: ev.d.maxUploadBytes,
          guildOrder: [],
          guilds: {},
          channels: {},
          members: {},
          voice: {},
          emotes: {},
          roles: {},
          presences: {},
          typing: {},
        };
        let acc: AppState = base;
        for (const g of ev.d.guilds) acc = { ...acc, ...withGuild(acc, g) };
        // The server's read state wins for mentions; for read position, whichever is further.
        const lastRead = { ...acc.lastRead };
        const pings: Record<string, number> = {};
        for (const r of ev.d.readStates) {
          const l = later(lastRead[r.channelId], r.lastReadId ?? undefined);
          if (l) lastRead[r.channelId] = l;
          if (r.mentionCount > 0) pings[r.channelId] = r.mentionCount;
        }
        saveLastRead(lastRead);
        set({ ...acc, lastRead, pings, connection: "ready" });
        return;
      }
      case "GUILD_CREATE":
        set((s) => withGuild(s, ev.d));
        return;
      case "GUILD_UPDATE":
        set((s) => ({ guilds: { ...s.guilds, [ev.d.id]: ev.d } }));
        return;
      case "GUILD_DELETE":
        set((s) => {
          const channels = Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.guildId !== ev.d.id));
          return {
            guilds: without(s.guilds, ev.d.id),
            guildOrder: s.guildOrder.filter((g) => g !== ev.d.id),
            channels,
            members: without(s.members, ev.d.id),
            voice: without(s.voice, ev.d.id),
            emotes: without(s.emotes, ev.d.id),
            roles: without(s.roles, ev.d.id),
          };
        });
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
        set((s) => ({ channels: { ...s.channels, [ev.d.id]: ev.d } }));
        return;
      case "CHANNEL_DELETE":
        set((s) => ({ channels: without(s.channels, ev.d.id) }));
        return;
      case "ROLE_CREATE":
      case "ROLE_UPDATE":
        set((s) => {
          const list = (s.roles[ev.d.guildId] ?? []).filter((r) => r.id !== ev.d.id);
          return { roles: { ...s.roles, [ev.d.guildId]: sortRoles([...list, ev.d]) } };
        });
        return;
      case "ROLE_DELETE":
        set((s) => {
          const gid = ev.d.guildId;
          const members = Object.fromEntries(
            Object.entries(s.members[gid] ?? {}).map(([uid, m]) => [uid, m.roles.includes(ev.d.id) ? { ...m, roles: m.roles.filter((r) => r !== ev.d.id) } : m]),
          );
          // Its channel overwrites went with it.
          const channels = { ...s.channels };
          for (const c of Object.values(s.channels)) {
            if (c.guildId === gid && c.overwrites.some((o) => o.kind === "role" && o.id === ev.d.id)) {
              channels[c.id] = { ...c, overwrites: c.overwrites.filter((o) => !(o.kind === "role" && o.id === ev.d.id)) };
            }
          }
          return { roles: { ...s.roles, [gid]: (s.roles[gid] ?? []).filter((r) => r.id !== ev.d.id) }, members: { ...s.members, [gid]: members }, channels };
        });
        return;
      case "MEMBER_ADD":
      case "MEMBER_UPDATE":
        set((s) => ({
          members: { ...s.members, [ev.d.guildId]: { ...s.members[ev.d.guildId], [ev.d.user.id]: ev.d } },
        }));
        return;
      case "MEMBER_REMOVE":
        set((s) => ({
          members: { ...s.members, [ev.d.guildId]: without(s.members[ev.d.guildId] ?? {}, ev.d.userId) },
        }));
        return;
      case "USER_UPDATE":
        set((s) => updateUserEverywhere(s, ev.d));
        return;
      case "PRESENCE_UPDATE":
        set((s) => ({ presences: { ...s.presences, [ev.d.userId]: ev.d.status } }));
        return;
      case "EMOTE_CREATE":
        set((s) => {
          const list = s.emotes[ev.d.guildId] ?? [];
          // Applied locally after an add and again when the gateway echoes it.
          if (list.some((e) => e.id === ev.d.id)) return s;
          return { emotes: { ...s.emotes, [ev.d.guildId]: [...list, ev.d] } };
        });
        return;
      case "EMOTE_UPDATE":
        set((s) => ({
          emotes: { ...s.emotes, [ev.d.guildId]: (s.emotes[ev.d.guildId] ?? []).map((e) => (e.id === ev.d.id ? ev.d : e)) },
        }));
        return;
      case "EMOTE_DELETE":
        set((s) => ({
          emotes: { ...s.emotes, [ev.d.guildId]: (s.emotes[ev.d.guildId] ?? []).filter((e) => e.id !== ev.d.id) },
        }));
        return;
      case "TYPING_START": {
        if (ev.d.userId === get().me?.id) return;
        set((s) => ({
          typing: { ...s.typing, [ev.d.channelId]: { ...s.typing[ev.d.channelId], [ev.d.userId]: Date.now() + 8000 } },
        }));
        return;
      }
      case "MESSAGE_CREATE": {
        const m = ev.d;
        inst.messages.getState().onCreate(m);
        set((s) => {
          const c = s.channels[m.channelId];
          const patch: Partial<AppState> = {};
          if (c && (!c.lastMessageId || compareIds(m.id, c.lastMessageId) > 0)) {
            patch.channels = { ...s.channels, [c.id]: { ...c, lastMessageId: m.id } };
          }
          if (s.typing[m.channelId]?.[m.author.id]) {
            patch.typing = { ...s.typing, [m.channelId]: without(s.typing[m.channelId], m.author.id) };
          }
          if (m.author.id === s.me?.id) {
            patch.lastRead = { ...s.lastRead, [m.channelId]: m.id };
            saveLastRead(patch.lastRead);
          }
          const seen =
            (s.lastRead[m.channelId] && compareIds(m.id, s.lastRead[m.channelId]) <= 0) ||
            (s.viewing === m.channelId && document.visibilityState === "visible");
          if (mentionsMe(m, s.me?.id) && !seen) patch.pings = { ...s.pings, [m.channelId]: (s.pings[m.channelId] ?? 0) + 1 };
          return patch;
        });
        return;
      }
      case "MESSAGE_UPDATE":
        inst.messages.getState().onUpdate(ev.d);
        return;
      case "MESSAGE_DELETE":
        inst.messages.getState().onDelete(ev.d.channelId, ev.d.id);
        return;
      case "READ_STATE_UPDATE":
        // Read on another device (or our own ack echoing back).
        set((s) => {
          const l = later(s.lastRead[ev.d.channelId], ev.d.lastReadId ?? undefined);
          const lastRead = l ? { ...s.lastRead, [ev.d.channelId]: l } : s.lastRead;
          if (l) saveLastRead(lastRead);
          const pings = ev.d.mentionCount ? { ...s.pings, [ev.d.channelId]: ev.d.mentionCount } : without(s.pings, ev.d.channelId);
          return { lastRead, pings };
        });
        return;
      case "REACTION_ADD":
      case "REACTION_REMOVE":
        inst.messages.getState().onReaction(ev.d, ev.t === "REACTION_ADD", get().me?.id);
        return;
      case "VOICE_STATE_UPDATE":
        set((s) => {
          // A user is in one channel at a time across all guilds.
          const voice = { ...s.voice };
          for (const gid of Object.keys(voice)) {
            if (gid !== ev.d.guildId && voice[gid][ev.d.userId]) voice[gid] = without(voice[gid], ev.d.userId);
          }
          voice[ev.d.guildId] = { ...voice[ev.d.guildId], [ev.d.userId]: ev.d };
          return { voice };
        });
        return;
      case "VOICE_STATE_REMOVE":
        set((s) => ({ voice: { ...s.voice, [ev.d.guildId]: without(s.voice[ev.d.guildId] ?? {}, ev.d.userId) } }));
        return;
      case "VOICE_SERVER":
        set({ voiceServer: ev.d });
        return;
      case "HELLO":
      case "HEARTBEAT_ACK":
      case "INVALID_SESSION":
        return;
    }
  },
}));
  expireTyping(store);
  return store;
}

export type AppStore = ReturnType<typeof createAppStore>;

/** This instance's state (see `useInstance`). */
export const useApp = instanceStore((i) => i.app);

// Expire typing indicators.
function expireTyping(store: AppStore) {
setInterval(() => {
  const { typing } = store.getState();
  const now = Date.now();
  let changed = false;
  const next: Record<string, Record<string, number>> = {};
  for (const [cid, users] of Object.entries(typing)) {
    const kept = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now));
    if (Object.keys(kept).length !== Object.keys(users).length) changed = true;
    if (Object.keys(kept).length) next[cid] = kept;
  }
  if (changed) store.setState({ typing: next });
}, 1000);
}

export function displayName(guildId: string | undefined, user: User): string {
  if (!guildId) return user.displayName;
  return useApp.getState().members[guildId]?.[user.id]?.nick ?? user.displayName;
}
