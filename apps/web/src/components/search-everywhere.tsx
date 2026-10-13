import type { Message } from "@app/protocol";
import { useQueries } from "@tanstack/react-query";

import { FoundMessages } from "@/components/chat/found-messages";
import { useDebounced } from "@/hooks/use-debounced";
import { snowflakeTime } from "@/lib/ids";
import { hubLabel } from "@/lib/hub-names";
import { InstanceProvider, instance, useInstanceList } from "@/lib/instances";

/** Messages matching `query` in every server you're in, on every host, newest first. */
export function SearchEverywhere({ query }: { query: string }) {
  const q = useDebounced(query, 300);
  const ids = useInstanceList((s) => s.ids);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["search-everywhere", id, q],
      enabled: q.length > 0,
      queryFn: async () => {
        const inst = instance(id);
        if (!inst) return [];
        const found = await inst.api<Message[]>("GET", `/messages/search?q=${encodeURIComponent(q)}`);
        return found.map((m) => ({ m, id }));
      },
    })),
  });
  if (!q) return <p className="px-8 py-6 text-muted-foreground">Search messages in every community you're in.</p>;
  const all = results
    .flatMap((r) => r.data ?? [])
    .sort((a, b) => snowflakeTime(b.m.id) - snowflakeTime(a.m.id));
  const loading = results.some((r) => r.isLoading);
  const failed = results.flatMap((r, i) => (r.isError ? [ids[i]] : []));
  return (
    <div className="flex max-w-3xl flex-col gap-1 px-8 py-6" data-testid="search-everywhere">
      {failed.map((id) => (
        <p key={id} className="text-sm text-destructive">
          Couldn't search {hubLabel(id).name}.
        </p>
      ))}
      {!loading && all.length === 0 && <p className="text-muted-foreground">No messages match.</p>}
      {all.map(({ m, id }) => {
        const inst = instance(id);
        const guildId = inst?.app.getState().channels[m.channelId]?.guildId;
        return inst && guildId ? (
          <InstanceProvider key={`${id}/${m.id}`} instance={inst}>
            <FoundMessages guildId={guildId} messages={[m]} showServer />
          </InstanceProvider>
        ) : null;
      })}
    </div>
  );
}
