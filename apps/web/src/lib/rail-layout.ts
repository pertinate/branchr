/**
 * How the server rail is arranged: one list of servers from every host, in the user's order,
 * with folders. Kept on this device. Servers you join or create go on top.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** `instanceId/guildId`: guild ids are only unique per host. */
export type GuildRef = string;

export const guildRef = (instanceId: string, guildId: string): GuildRef => `${instanceId}/${guildId}`;

export function parseRef(ref: GuildRef): { instanceId: string; guildId: string } {
  const at = ref.lastIndexOf("/");
  return { instanceId: ref.slice(0, at), guildId: ref.slice(at + 1) };
}

export interface Folder {
  id: string;
  name: string;
  /** A colour from FOLDER_COLORS, or null for the default. */
  color: string | null;
  open: boolean;
  guilds: GuildRef[];
}

export type RailItem = { guild: GuildRef } | { folder: Folder };

export const FOLDER_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#9b59b6", "#1abc9c", "#99aab5"];

/** What a drag is over: an item's key (a guild ref, or `folder:<id>`) and where on it. */
export interface DropTarget {
  key: string;
  zone: "before" | "after" | "into";
}

export const itemKey = (item: RailItem) => ("guild" in item ? item.guild : `folder:${item.folder.id}`);

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Takes `key` (a guild anywhere, or a top-level folder) out of `items`. Empty folders go too. */
function take(items: RailItem[], key: string): { items: RailItem[]; taken: RailItem | null } {
  let taken: RailItem | null = null;
  const out: RailItem[] = [];
  for (const item of items) {
    if (itemKey(item) === key) {
      taken = item;
      continue;
    }
    if ("folder" in item && item.folder.guilds.includes(key)) {
      taken = { guild: key };
      const guilds = item.folder.guilds.filter((g) => g !== key);
      if (guilds.length) out.push({ folder: { ...item.folder, guilds } });
      continue;
    }
    out.push(item);
  }
  return { items: out, taken };
}

/** Moves `key` to `target`. Folders don't go inside folders; dropping a server on a server makes one. */
export function moveItem(items: RailItem[], key: string, target: DropTarget): RailItem[] {
  if (key === target.key) return items;
  const { items: rest, taken } = take(items, key);
  if (!taken) return items;
  const isFolder = "folder" in taken;
  const out: RailItem[] = [];
  let placed = false;
  for (const item of rest) {
    const k = itemKey(item);
    if (k === target.key) {
      placed = true;
      if (target.zone === "into" && !isFolder) {
        if ("folder" in item) out.push({ folder: { ...item.folder, guilds: [...item.folder.guilds, (taken as { guild: GuildRef }).guild] } });
        else out.push({ folder: { id: newId(), name: "", color: null, open: false, guilds: [item.guild, (taken as { guild: GuildRef }).guild] } });
      } else if (target.zone === "after") out.push(item, taken);
      else out.push(taken, item);
      continue;
    }
    // A target inside a folder: a server goes in next to it; a folder goes next to the folder.
    if ("folder" in item && item.folder.guilds.includes(target.key)) {
      placed = true;
      if (isFolder) {
        out.push(...(target.zone === "after" ? [item, taken] : [taken, item]));
      } else {
        const guilds = item.folder.guilds.flatMap((g) =>
          g !== target.key ? [g] : target.zone === "after" ? [g, (taken as { guild: GuildRef }).guild] : [(taken as { guild: GuildRef }).guild, g],
        );
        out.push({ folder: { ...item.folder, guilds } });
      }
      continue;
    }
    out.push(item);
  }
  return placed ? out : items;
}

/**
 * Brings the layout in line with one host's servers (once it's connected): new ones go on top,
 * except the first time we see a host, when its servers go at the end in its order. Servers
 * it no longer has are dropped.
 */
export function syncHost(items: RailItem[], seen: string[], instanceId: string, guildIds: string[]): { items: RailItem[]; seen: string[] } | null {
  const have = new Set(guildIds.map((g) => guildRef(instanceId, g)));
  const placed = new Set<GuildRef>();
  let changed = false;
  const kept: RailItem[] = [];
  for (const item of items) {
    if ("guild" in item) {
      if (parseRef(item.guild).instanceId === instanceId && !have.has(item.guild)) {
        changed = true;
        continue;
      }
      placed.add(item.guild);
      kept.push(item);
    } else {
      const guilds = item.folder.guilds.filter((g) => parseRef(g).instanceId !== instanceId || have.has(g));
      if (guilds.length !== item.folder.guilds.length) changed = true;
      guilds.forEach((g) => placed.add(g));
      if (guilds.length) kept.push(guilds.length === item.folder.guilds.length ? item : { folder: { ...item.folder, guilds } });
    }
  }
  const fresh = guildIds.map((g) => guildRef(instanceId, g)).filter((r) => !placed.has(r));
  const first = !seen.includes(instanceId);
  if (!fresh.length && !changed && !first) return null;
  const added = fresh.map((guild) => ({ guild }));
  // A host's order lists the newest last; the newest goes topmost.
  const next = first ? [...kept, ...added] : [...added.reverse(), ...kept];
  return { items: next, seen: first ? [...seen, instanceId] : seen };
}

/** Drops everything from hosts we're no longer logged in to. */
export function pruneHosts(items: RailItem[], seen: string[], live: string[]): { items: RailItem[]; seen: string[] } | null {
  const keep = (r: GuildRef) => live.includes(parseRef(r).instanceId);
  const nextSeen = seen.filter((s) => live.includes(s));
  let changed = nextSeen.length !== seen.length;
  const out: RailItem[] = [];
  for (const item of items) {
    if ("guild" in item) {
      if (keep(item.guild)) out.push(item);
      else changed = true;
    } else {
      const guilds = item.folder.guilds.filter(keep);
      if (guilds.length !== item.folder.guilds.length) changed = true;
      if (guilds.length) out.push(guilds.length === item.folder.guilds.length ? item : { folder: { ...item.folder, guilds } });
    }
  }
  return changed ? { items: out, seen: nextSeen } : null;
}

interface RailLayout {
  items: RailItem[];
  seen: string[];
  sync(instanceId: string, guildIds: string[]): void;
  prune(live: string[]): void;
  move(key: string, target: DropTarget): void;
  updateFolder(id: string, patch: Partial<Omit<Folder, "id" | "guilds">>): void;
  /** Puts a server in a new folder of its own, where it is. */
  newFolder(ref: GuildRef): void;
  /** Takes a server out of its folder, to just after the folder. */
  unfolder(ref: GuildRef): void;
  /** Dissolves a folder, leaving its servers in its place. */
  ungroup(id: string): void;
}

export const useRailLayout = create<RailLayout>()(
  persist(
    (set) => ({
      items: [],
      seen: [],
      sync: (instanceId, guildIds) =>
        set((s) => syncHost(s.items, s.seen, instanceId, guildIds) ?? s),
      prune: (live) => set((s) => pruneHosts(s.items, s.seen, live) ?? s),
      move: (key, target) => set((s) => ({ items: moveItem(s.items, key, target) })),
      updateFolder: (id, patch) =>
        set((s) => ({ items: s.items.map((i) => ("folder" in i && i.folder.id === id ? { folder: { ...i.folder, ...patch } } : i)) })),
      newFolder: (ref) =>
        set((s) => ({
          items: s.items.map((i) => ("guild" in i && i.guild === ref ? { folder: { id: newId(), name: "", color: null, open: true, guilds: [ref] } } : i)),
        })),
      unfolder: (ref) =>
        set((s) => {
          const folder = s.items.find((i): i is { folder: Folder } => "folder" in i && i.folder.guilds.includes(ref));
          if (!folder) return s;
          // Its last server: the folder simply goes away.
          if (folder.folder.guilds.length === 1) return { items: s.items.map((i) => (i === folder ? { guild: ref } : i)) };
          return { items: moveItem(s.items, ref, { key: itemKey(folder), zone: "after" }) };
        }),
      ungroup: (id) => set((s) => ({ items: s.items.flatMap((i) => ("folder" in i && i.folder.id === id ? i.folder.guilds.map((guild) => ({ guild })) : [i])) })),
    }),
    { name: "rail-layout", version: 1 },
  ),
);
