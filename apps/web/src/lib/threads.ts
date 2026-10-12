import type { Channel } from "@app/protocol";

const byStarter = new WeakMap<object, Map<string, Channel>>();

/** Threads by the message they started from; built once per channels snapshot. */
export function threadsByStarter(channels: Record<string, Channel>): Map<string, Channel> {
  let map = byStarter.get(channels);
  if (!map) {
    map = new Map();
    for (const c of Object.values(channels)) if (c.kind === "thread" && c.starterMessageId) map.set(c.starterMessageId, c);
    byStarter.set(channels, map);
  }
  return map;
}
