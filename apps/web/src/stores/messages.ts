import type { Message, ReactionEvent } from "@app/protocol";
import { create } from "zustand";

import { api } from "@/lib/api";
import { compareIds, nonce } from "@/lib/ids";
import { useAuth } from "@/stores/auth";

export type UiMessage = Message & { pending?: boolean; failed?: boolean };

export interface ChannelMessages {
  /** Oldest first. */
  items: UiMessage[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

const PAGE = 50;
/** Channels not being viewed are trimmed to this many messages to bound memory. */
const KEEP = 200;

interface MessagesState {
  channels: Record<string, ChannelMessages>;
  load: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  send: (channelId: string, content: string, replyTo?: string | null) => Promise<void>;
  retry: (channelId: string, nonce: string) => Promise<void>;
  trim: (channelId: string) => void;
  onCreate: (m: Message) => void;
  onUpdate: (m: Message) => void;
  onDelete: (channelId: string, id: string) => void;
  onReaction: (r: ReactionEvent, add: boolean, me: string | undefined) => void;
}

const empty: ChannelMessages = { items: [], hasMore: true, loading: false, loaded: false };

function insertSorted(items: UiMessage[], m: UiMessage): UiMessage[] {
  // Fast path: newest message (the overwhelmingly common case).
  const last = items[items.length - 1];
  if (!last || last.pending || compareIds(m.id, last.id) > 0) {
    // Keep optimistic (pending) messages at the bottom.
    const firstPending = items.findIndex((x) => x.pending);
    if (firstPending === -1) return [...items, m];
    return [...items.slice(0, firstPending), m, ...items.slice(firstPending)];
  }
  if (items.some((x) => x.id === m.id)) return items;
  const idx = items.findIndex((x) => !x.pending && compareIds(x.id, m.id) > 0);
  return idx === -1 ? [...items, m] : [...items.slice(0, idx), m, ...items.slice(idx)];
}

export const useMessages = create<MessagesState>()((set, get) => {
  const patch = (channelId: string, f: (c: ChannelMessages) => ChannelMessages) =>
    set((s) => ({ channels: { ...s.channels, [channelId]: f(s.channels[channelId] ?? empty) } }));

  const post = async (channelId: string, content: string, n: string, replyTo: string | null) => {
    try {
      const m = await api<Message>("POST", `/channels/${channelId}/messages`, { content, nonce: n, replyTo });
      get().onCreate({ ...m, nonce: n });
    } catch {
      patch(channelId, (c) => ({
        ...c,
        items: c.items.map((x) => (x.nonce === n ? { ...x, failed: true, pending: false } : x)),
      }));
    }
  };

  return {
    channels: {},
    load: async (channelId) => {
      const cur = get().channels[channelId];
      if (cur?.loaded || cur?.loading) return;
      patch(channelId, (c) => ({ ...c, loading: true }));
      try {
        const page = await api<Message[]>("GET", `/channels/${channelId}/messages?limit=${PAGE}`);
        patch(channelId, (c) => {
          // Merge with anything that arrived over the gateway while loading.
          let items: UiMessage[] = page.reverse();
          for (const m of c.items) items = insertSorted(items, m);
          return { items, hasMore: page.length === PAGE, loading: false, loaded: true };
        });
      } catch {
        patch(channelId, (c) => ({ ...c, loading: false }));
      }
    },
    loadOlder: async (channelId) => {
      const cur = get().channels[channelId];
      if (!cur || cur.loading || !cur.hasMore) return;
      const oldest = cur.items.find((m) => !m.pending);
      if (!oldest) return;
      patch(channelId, (c) => ({ ...c, loading: true }));
      try {
        const page = await api<Message[]>("GET", `/channels/${channelId}/messages?limit=${PAGE}&before=${oldest.id}`);
        patch(channelId, (c) => ({
          ...c,
          items: [...page.reverse(), ...c.items],
          hasMore: page.length === PAGE,
          loading: false,
        }));
      } catch {
        patch(channelId, (c) => ({ ...c, loading: false }));
      }
    },
    send: async (channelId, content, replyTo = null) => {
      const me = useAuth.getState().user;
      if (!me) return;
      const n = nonce();
      const optimistic: UiMessage = {
        id: `pending-${n}`,
        channelId,
        author: me,
        content,
        editedAt: null,
        replyTo,
        reactions: [],
        nonce: n,
        pending: true,
      };
      patch(channelId, (c) => ({ ...c, items: [...c.items, optimistic] }));
      await post(channelId, content, n, replyTo);
    },
    retry: async (channelId, n) => {
      const m = get().channels[channelId]?.items.find((x) => x.nonce === n);
      if (!m) return;
      patch(channelId, (c) => ({
        ...c,
        items: c.items.map((x) => (x.nonce === n ? { ...x, failed: false, pending: true } : x)),
      }));
      await post(channelId, m.content, n, m.replyTo);
    },
    trim: (channelId) => {
      const c = get().channels[channelId];
      if (!c || c.items.length <= KEEP) return;
      patch(channelId, (c) => ({ ...c, items: c.items.slice(-KEEP), hasMore: true }));
    },
    onCreate: (m) => {
      if (!get().channels[m.channelId]) return; // never opened; will load fresh
      patch(m.channelId, (c) => {
        if (m.nonce) {
          const idx = c.items.findIndex((x) => x.nonce === m.nonce && x.pending !== undefined);
          if (idx !== -1) {
            const rest = c.items.filter((_, i) => i !== idx);
            return { ...c, items: insertSorted(rest, { ...m, pending: undefined, failed: undefined }) };
          }
        }
        if (c.items.some((x) => x.id === m.id)) return c;
        return { ...c, items: insertSorted(c.items, m) };
      });
    },
    onUpdate: (m) => {
      if (!get().channels[m.channelId]) return;
      patch(m.channelId, (c) => ({
        ...c,
        // Keep our local view of reactions; edits don't change them.
        items: c.items.map((x) => (x.id === m.id ? { ...m, reactions: x.reactions } : x)),
      }));
    },
    onDelete: (channelId, id) => {
      if (!get().channels[channelId]) return;
      patch(channelId, (c) => ({ ...c, items: c.items.filter((x) => x.id !== id) }));
    },
    onReaction: (r, add, me) => {
      if (!get().channels[r.channelId]) return;
      const mine = r.userId === me;
      patch(r.channelId, (c) => ({
        ...c,
        items: c.items.map((x) => {
          if (x.id !== r.messageId) return x;
          const existing = x.reactions.find((e) => e.emoji === r.emoji);
          let reactions;
          if (add) {
            if (existing && mine && existing.me) return x;
            reactions = existing
              ? x.reactions.map((e) => (e.emoji === r.emoji ? { ...e, count: e.count + 1, me: e.me || mine } : e))
              : [...x.reactions, { emoji: r.emoji, count: 1, me: mine }];
          } else {
            if (!existing) return x;
            reactions = x.reactions
              .map((e) => (e.emoji === r.emoji ? { ...e, count: e.count - 1, me: mine ? false : e.me } : e))
              .filter((e) => e.count > 0);
          }
          return { ...x, reactions };
        }),
      }));
    },
  };
});
