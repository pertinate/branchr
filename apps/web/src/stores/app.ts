import type {
  Channel,
  Emote,
  Guild,
  Member,
  ReadyGuild,
  ServerEvent,
  Status,
  User,
  VoiceServer,
  VoiceState,
} from "@app/protocol";
import { create } from "zustand";

import { compareIds } from "@/lib/ids";
import { useMessages } from "@/stores/messages";

export type ConnectionState = "idle" | "connecting" | "ready" | "reconnecting";

interface AppState {
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
  /** channel id -> user id -> expiry timestamp */
  typing: Record<string, Record<string, number>>;
  /** Pending voice server handoff for our own join. */
  voiceServer: VoiceServer | null;
  /** channel id -> last message id we've seen */
  lastRead: Record<string, string>;
  setConnection: (c: ConnectionState) => void;
  markRead: (channelId: string) => void;
  apply: (ev: ServerEvent) => void;
}

const LAST_READ_KEY = "lastRead";
function loadLastRead(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_READ_KEY) ?? "{}");
  } catch {
    return {};
  }
}
let lastReadTimer: ReturnType<typeof setTimeout> | undefined;
function saveLastRead(v: Record<string, string>) {
  clearTimeout(lastReadTimer);
  lastReadTimer = setTimeout(() => {
    try {
      localStorage.setItem(LAST_READ_KEY, JSON.stringify(v));
    } catch {
      /* storage full or unavailable */
    }
  }, 500);
}

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
    presences,
  };
}

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

export const useApp = create<AppState>()((set, get) => ({
  connection: "idle",
  me: null,
  guildOrder: [],
  guilds: {},
  channels: {},
  members: {},
  presences: {},
  voice: {},
  emotes: {},
  typing: {},
  voiceServer: null,
  lastRead: loadLastRead(),
  setConnection: (connection) => set({ connection }),
  markRead: (channelId) => {
    const last = get().channels[channelId]?.lastMessageId;
    if (!last || get().lastRead[channelId] === last) return;
    const lastRead = { ...get().lastRead, [channelId]: last };
    saveLastRead(lastRead);
    set({ lastRead });
  },
  apply: (ev) => {
    switch (ev.t) {
      case "READY": {
        const base: AppState = {
          ...get(),
          me: ev.d.user,
          guildOrder: [],
          guilds: {},
          channels: {},
          members: {},
          voice: {},
          emotes: {},
          presences: {},
          typing: {},
        };
        let acc: AppState = base;
        for (const g of ev.d.guilds) acc = { ...acc, ...withGuild(acc, g) };
        set({ ...acc, connection: "ready" });
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
        useMessages.getState().onCreate(m);
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
          return patch;
        });
        return;
      }
      case "MESSAGE_UPDATE":
        useMessages.getState().onUpdate(ev.d);
        return;
      case "MESSAGE_DELETE":
        useMessages.getState().onDelete(ev.d.channelId, ev.d.id);
        return;
      case "REACTION_ADD":
      case "REACTION_REMOVE":
        useMessages.getState().onReaction(ev.d, ev.t === "REACTION_ADD", get().me?.id);
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

// Expire typing indicators.
setInterval(() => {
  const { typing } = useApp.getState();
  const now = Date.now();
  let changed = false;
  const next: Record<string, Record<string, number>> = {};
  for (const [cid, users] of Object.entries(typing)) {
    const kept = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now));
    if (Object.keys(kept).length !== Object.keys(users).length) changed = true;
    if (Object.keys(kept).length) next[cid] = kept;
  }
  if (changed) useApp.setState({ typing: next });
}, 1000);

export function displayName(guildId: string | undefined, user: User): string {
  if (!guildId) return user.displayName;
  return useApp.getState().members[guildId]?.[user.id]?.nick ?? user.displayName;
}
