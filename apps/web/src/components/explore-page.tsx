import type { Listing, ReadyGuild } from "@app/protocol";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Compass, Search, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { guildInitials } from "@/components/guild/guild-badge";
import { SearchEverywhere } from "@/components/search-everywhere";
import { YourServers } from "@/components/your-servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebounced } from "@/hooks/use-debounced";
import { ID_URL } from "@/lib/branchr-id";
import { hostOf, instance, instanceKey, normalizeUrl } from "@/lib/instances";
import { cn } from "@/lib/utils";

const TAGS = ["gaming", "music", "art", "tech", "anime", "study", "community"];

export type ExploreTab = "yours" | "discover" | "messages";

/**
 * Your servers (by host) and Discover (servers every host chose to list), under one search.
 */
export function ExplorePage({ tab, onTab }: { tab: ExploreTab; onTab: (t: ExploreTab) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const q = useDebounced(query.trim(), 250);
  const results = useQuery({
    queryKey: ["explore", q, tag],
    enabled: tab === "discover",
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
    // Already in it: just go there.
    if (inst.app.getState().guilds[l.server.guildId]) {
      void navigate({ to: "/$instance/$guildId", params: { instance: inst.id, guildId: l.server.guildId } });
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
      <Tabs value={tab} onValueChange={(t) => onTab(t as ExploreTab)} className="gap-0">
        <div className="bg-gradient-to-br from-primary/40 to-primary/5 px-8 pt-10 pb-4">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Compass /> Explore
          </h1>
          <p className="mt-1 text-muted-foreground">Your communities on every hub, communities anyone can join, and messages everywhere you are.</p>
          <div className="relative mt-4 max-w-xl">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search communities" aria-label="Search communities" className="h-10 bg-background pl-9" />
          </div>
          <TabsList className="mt-4">
            <TabsTrigger value="yours">Your Communities</TabsTrigger>
            <TabsTrigger value="discover">Discover</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="yours">
          <YourServers query={query.trim()} />
        </TabsContent>
        <TabsContent value="messages">
          <SearchEverywhere query={query.trim()} />
        </TabsContent>
        <TabsContent value="discover">
          <div className="flex flex-wrap gap-1.5 px-8 pt-6">
            {TAGS.map((t) => (
              <button
                key={t}
                onClick={() => setTag(tag === t ? null : t)}
                className={cn("rounded-full px-3 py-0.5 text-sm", tag === t ? "bg-primary text-white" : "bg-sidebar hover:bg-accent")}
              >
                {t}
              </button>
            ))}
          </div>
      <div className="grid gap-4 p-8 sm:grid-cols-2 xl:grid-cols-3" data-testid="explore-results">
        {results.isError && <p className="text-destructive">{(results.error as Error).message}</p>}
        {results.data?.length === 0 && <p className="text-muted-foreground">No communities match.</p>}
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
                <JoinButton listing={l} busy={joining === key} onClick={() => void join(l)} />
              </div>
            </article>
          );
        })}
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}

/** "Join", or "Open" for a server you're already in. */
function JoinButton({ listing: l, busy, onClick }: { listing: Listing; busy: boolean; onClick: () => void }) {
  const inst = instance(instanceKey(normalizeUrl(l.hostUrl)));
  const joined = !!inst && !!inst.app((s) => s.guilds[l.server.guildId]);
  return (
    <Button size="sm" variant={joined ? "secondary" : "default"} className="ml-auto" disabled={busy} onClick={onClick} aria-label={`${joined ? "Open" : "Join"} ${l.server.name}`}>
      {joined ? "Open" : "Join"}
    </Button>
  );
}
