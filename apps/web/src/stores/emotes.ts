import type { Emote, Guild } from "@app/protocol";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { api } from "@/lib/api";
import { useApp } from "@/stores/app";

/** Emotes from every server the user is in, grouped by server, `first` server first. */
export function useEmoteGroups(first: string): { guild: Guild; emotes: Emote[] }[] {
  const [order, guilds, emotes] = useApp(useShallow((s) => [s.guildOrder, s.guilds, s.emotes] as const));
  return useMemo(() => {
    const ids = [first, ...order.filter((g) => g !== first)];
    return ids.filter((g) => guilds[g] && emotes[g]?.length).map((g) => ({ guild: guilds[g], emotes: emotes[g] }));
  }, [first, order, guilds, emotes]);
}

/** id -> emote across all of the user's servers. */
export function useAllEmotesById(): Map<string, Emote> {
  const emotes = useApp((s) => s.emotes);
  return useMemo(() => {
    const m = new Map<string, Emote>();
    for (const list of Object.values(emotes)) for (const e of list) m.set(e.id, e);
    return m;
  }, [emotes]);
}

/**
 * Emotes looked up by id from servers the user isn't in (e.g. someone reacted with one).
 * Requests made in the same tick are batched into one call; `null` = doesn't exist.
 */
interface LookupState {
  byId: Record<string, Emote | null>;
  request: (id: string) => void;
}

const queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export const useEmoteLookup = create<LookupState>()((set, get) => {
  const schedule = () => {
    timer ??= setTimeout(flush, 20);
  };
  const flush = async () => {
    timer = null;
    const ids = [...queued].slice(0, 100);
    for (const i of ids) queued.delete(i);
    if (queued.size) schedule();
    try {
      const found = await api<Emote[]>("GET", `/emotes/lookup?ids=${ids.join(",")}`);
      const byId = { ...get().byId };
      for (const i of ids) byId[i] = null;
      for (const e of found) byId[e.id] = e;
      set({ byId });
    } catch {
      // Leave unresolved; the next render that needs it asks again.
    }
  };
  return {
    byId: {},
    request: (id) => {
      if (id in get().byId || queued.has(id)) return;
      queued.add(id);
      schedule();
    },
  };
});

/** Any emote by id: the user's servers first, else a (batched) lookup. */
export function useEmote(id: string | undefined, known: Map<string, Emote>): Emote | undefined {
  const local = id ? known.get(id) : undefined;
  const remote = useEmoteLookup((s) => (id && !local ? s.byId[id] : undefined));
  const missing = !!id && !local && remote === undefined;
  useEffect(() => {
    if (missing) useEmoteLookup.getState().request(id);
  }, [missing, id]);
  return local ?? remote ?? undefined;
}

/** The emote info card opened by clicking an emote in a message. */
interface CardState {
  card: { emote: Emote; x: number; y: number } | null;
  open: (emote: Emote, el: Element) => void;
  close: () => void;
}

export const useEmoteCard = create<CardState>()((set) => ({
  card: null,
  open: (emote, el) => {
    const r = el.getBoundingClientRect();
    set({ card: { emote, x: r.left + r.width / 2, y: r.top } });
  },
  close: () => set({ card: null }),
}));
