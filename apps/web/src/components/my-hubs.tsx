import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ownedHosts, useBranchrId } from "@/lib/branchr-id";
import { hostOf, instanceKey, normalizeUrl, useInstanceList, useSessions } from "@/lib/instances";

/** The signed-in account's own hubs that this device isn't on yet, one click each, so
 *  nobody has to type a relayed address. */
export function MyHubs({ busy, onPick }: { busy?: boolean; onPick: (url: string) => void }) {
  const signedIn = useBranchrId((s) => !!s.refreshToken);
  const owned = useQuery({ queryKey: ["owned-hosts"], queryFn: ownedHosts, enabled: signedIn });
  // Before the app has started its instances, only the saved sessions say where we are.
  const live = useInstanceList((s) => s.ids);
  const saved = useSessions((s) => s.sessions);
  const here = new Set([...live, ...saved.map((s) => s.id)]);
  const hubs = (owned.data ?? []).filter((h) => h.publicUrl && !here.has(instanceKey(normalizeUrl(h.publicUrl))));
  if (!signedIn || !hubs.length) return null;
  return (
    <div className="space-y-2" data-testid="my-hubs">
      <div className="text-xs font-bold text-muted-foreground uppercase">Your hubs</div>
      {hubs.map((h) => (
        <Button key={h.instanceId} type="button" variant="secondary" className="h-auto w-full justify-between gap-3 py-2" disabled={busy} onClick={() => onPick(normalizeUrl(h.publicUrl))}>
          <span className="min-w-0 truncate text-left">
            {h.name}
            <span className="block truncate text-xs font-normal text-muted-foreground">{hostOf(h.publicUrl)}</span>
          </span>
          <span className="shrink-0">Connect</span>
        </Button>
      ))}
    </div>
  );
}
