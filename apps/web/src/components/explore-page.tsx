import type { Listing, ReadyGuild } from "@app/protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Compass, Search, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { guildInitials } from "@/components/guild/guild-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebounced } from "@/hooks/use-debounced";
import { ID_URL } from "@/lib/branchr-id";
import { hostOf, instance, instanceKey, normalizeUrl } from "@/lib/instances";
import { cn } from "@/lib/utils";

const TAGS = ["gaming", "music", "art", "tech", "anime", "study", "community"];

/** Servers that hosts publish to branchr ID, from every host. */
export function ExplorePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: ["explore", q, tag],
    // A live directory: listings come and go, so never show a cached page as current.
    staleTime: 0,
    queryFn: async () => {
      const params = new URLSearchParams({ q, ...(tag && { tag }) });
      const r = await fetch(`${ID_URL}/discover?${params}`);
      if (!r.ok) throw new Error(`Explore is unavailable (${r.status})`);
      return (await r.json()) as Listing[];
    },
  });
  const [joining, setJoining] = useState<string | null>(null);

  const join = async (l: Listing) => {
    const server = normalizeUrl(l.hostUrl);
    const inst = instance(instanceKey(server));
    // A host we're not on yet: log in there first, then the invite carries on.
    if (!inst) {
      void navigate({ to: "/login", search: { redirect: undefined, server, invite: l.server.invite } });
      return;
    }
    setJoining(`${l.hostUrl}/${l.server.guildId}`);
    try {
      const g = await inst.api<ReadyGuild>("POST", `/invites/${encodeURIComponent(l.server.invite)}`);
      inst.app.getState().apply({ t: "GUILD_CREATE", d: g });
      void navigate({ to: "/$instance/$guildId", params: { instance: inst.id, guildId: g.guild.id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setJoining(null);
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="bg-gradient-to-br from-primary/40 to-primary/5 px-8 py-10">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Compass /> Find your community
        </h1>
        <p className="mt-1 text-muted-foreground">Servers on every branchr host that chose to be listed.</p>
        <div className="relative mt-4 max-w-xl">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Explore servers" aria-label="Explore servers" className="h-10 bg-background pl-9" />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {TAGS.map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? null : t)}
              className={cn("rounded-full px-3 py-0.5 text-sm", tag === t ? "bg-primary text-white" : "bg-background/60 hover:bg-background")}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 p-8 sm:grid-cols-2 xl:grid-cols-3" data-testid="explore-results">
        {results.isError && <p className="text-destructive">{(results.error as Error).message}</p>}
        {results.data?.length === 0 && <p className="text-muted-foreground">No servers match.</p>}
        {results.data?.map((l) => {
          const key = `${l.hostUrl}/${l.server.guildId}`;
          return (
            <article key={key} className="flex flex-col rounded-lg bg-sidebar p-4" data-testid="explore-card">
              <div className="flex items-center gap-3">
                <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl bg-background font-semibold">
                  {l.server.iconUrl ? <img src={l.server.iconUrl} alt="" className="size-full object-cover" /> : guildInitials(l.server.name)}
                </span>
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{l.server.name}</h2>
                  <div className="truncate text-xs text-muted-foreground">on {hostOf(l.hostUrl)}</div>
                </div>
              </div>
              <p className="mt-2 line-clamp-3 flex-1 text-sm text-muted-foreground">{l.server.description}</p>
              {l.server.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {l.server.tags.map((t) => (
                    <span key={t} className="rounded bg-background px-1.5 text-xs">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-online" /> {l.server.online} online
                </span>
                <span className="flex items-center gap-1">
                  <Users className="size-3" /> {l.server.members} members
                </span>
                <Button size="sm" className="ml-auto" disabled={joining === key} onClick={() => void join(l)} aria-label={`Join ${l.server.name}`}>
                  Join
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
