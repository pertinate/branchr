import type { Channel } from "@app/protocol";

import { compareIds } from "@/lib/ids";

export interface Placement {
  id: string;
  position: number;
  parentId: string | null;
}

/** Where a dragged channel or category is dropped: next to `id`, or into category `id`. */
export interface ChannelDrop {
  id: string;
  zone: "before" | "after" | "into";
}

const byPosition = (a: Channel, b: Channel) => a.position - b.position || compareIds(a.id, b.id);

/** A category's channels (or the top level's) as the list shows them: text above voice. */
function listed(channels: Channel[], parent: string | null) {
  return channels
    .filter((c) => c.kind !== "category" && c.kind !== "thread" && (c.parentId ?? null) === parent)
    .sort(byPosition)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "text" ? -1 : 1));
}

/** What changes when `dragId` is dropped at `drop`: only the channels whose place moves. */
export function reorder(channels: Channel[], dragId: string, drop: ChannelDrop): Placement[] {
  const dragged = channels.find((c) => c.id === dragId);
  const target = channels.find((c) => c.id === drop.id);
  if (!dragged || !target || dragged.id === target.id) return [];
  const changes = new Map<string, Placement>();
  const settle = (list: Channel[], parent: string | null) =>
    list.forEach((c, position) => {
      if (c.position !== position || (c.parentId ?? null) !== parent) changes.set(c.id, { id: c.id, position, parentId: parent });
    });

  if (dragged.kind === "category") {
    // Categories move among categories; dropping on a channel means beside its category.
    const anchor = target.kind === "category" ? target : channels.find((c) => c.id === target.parentId);
    if (!anchor || anchor.id === dragged.id) return [];
    const cats = channels.filter((c) => c.kind === "category" && c.id !== dragged.id).sort(byPosition);
    const at = cats.findIndex((c) => c.id === anchor.id) + (drop.zone === "before" ? 0 : 1);
    cats.splice(at, 0, dragged);
    settle(cats, null);
    return [...changes.values()];
  }

  const from = dragged.parentId ?? null;
  const into = target.kind === "category" ? target.id : (target.parentId ?? null);
  const dest = listed(channels, into).filter((c) => c.id !== dragged.id);
  const at = target.kind === "category" ? dest.length : dest.findIndex((c) => c.id === target.id) + (drop.zone === "after" ? 1 : 0);
  dest.splice(Math.max(0, at), 0, dragged);
  settle(dest, into);
  if (from !== into) settle(listed(channels, from).filter((c) => c.id !== dragged.id), from);
  return [...changes.values()];
}
