import { useCallback, useSyncExternalStore } from "react";

import { instance, instances, useInstanceList } from "@/lib/instances";
import { parseRef, useRailLayout } from "@/lib/rail-layout";

/**
 * Which hub a community lives on, for addresses that name only the community (like
 * Discord's). A connected hub that has it wins; before hubs connect, the rail remembers.
 * `settled` once every hub has connected, so "nowhere" can be believed.
 */
export function useGuildHub(guildId: string): { id: string | null; settled: boolean } {
  const ids = useInstanceList((s) => s.ids);
  const subscribe = useCallback(
    (cb: () => void) => {
      const offs = ids.flatMap((id) => {
        const inst = instance(id);
        return inst ? [inst.app.subscribe(cb)] : [];
      });
      offs.push(useRailLayout.subscribe(cb));
      return () => offs.forEach((off) => off());
    },
    [ids],
  );
  const snapshot = useCallback(() => {
    const live = instances();
    const found = live.find((i) => i.app.getState().guilds[guildId]);
    let id = found?.id ?? null;
    if (!id) {
      const refs = useRailLayout.getState().items.flatMap((i) => ("guild" in i ? [i.guild] : i.folder.guilds));
      const remembered = refs.map(parseRef).find((r) => r.guildId === guildId && live.some((i) => i.id === r.instanceId));
      id = remembered?.instanceId ?? null;
    }
    const settled = live.every((i) => i.app.getState().connection === "ready");
    return `${id ?? ""}|${settled}`;
  }, [guildId]);
  const [id, settled] = useSyncExternalStore(subscribe, snapshot).split("|");
  return { id: id || null, settled: settled === "true" };
}
