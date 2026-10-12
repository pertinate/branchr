import type { Message } from "@app/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { X } from "lucide-react";

import { FoundMessages } from "@/components/chat/found-messages";
import { Button } from "@/components/ui/button";
import { useInstance } from "@/lib/instances";

const PAGE = 25;

/** Search results for a server, in place of the member list. */
export function SearchPanel({ guildId, query, onClose }: { guildId: string; query: string; onClose: () => void }) {
  const inst = useInstance();
  const results = useInfiniteQuery({
    queryKey: ["search", inst.id, guildId, query],
    queryFn: ({ pageParam }) => inst.api<Message[]>("GET", `/guilds/${guildId}/messages/search?q=${encodeURIComponent(query)}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  });
  const found = results.data?.pages.flat() ?? [];
  return (
    <aside className="flex w-96 shrink-0 flex-col bg-background/60" data-testid="search-panel">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4">
        <span className="flex-1 truncate text-sm font-semibold">{results.isFetching && !found.length ? "Searching…" : `${found.length}${results.hasNextPage ? "+" : ""} results`}</span>
        <button aria-label="Close search" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {results.isError && <p className="text-sm text-destructive">{(results.error as Error).message}</p>}
        {results.data && !found.length && <p className="py-8 text-center text-sm text-muted-foreground">No messages match.</p>}
        <FoundMessages guildId={guildId} messages={found} />
        {results.hasNextPage && (
          <Button variant="ghost" size="sm" className="mt-2 w-full" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
            More results
          </Button>
        )}
      </div>
    </aside>
  );
}
