import type { Emote, Guild, SevenTvEmote } from "@app/protocol";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebounced } from "@/hooks/use-debounced";
import { api } from "@/lib/api";
import { emoteSrcSet, emoteUrl } from "@/lib/emotes";
import { useApp } from "@/stores/app";

export function GuildSettingsDialog({ guildId, tab, onClose }: { guildId: string; tab: "overview" | "emotes"; onClose: () => void }) {
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Server Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={tab} className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            {isOwner && <TabsTrigger value="overview">Overview</TabsTrigger>}
            <TabsTrigger value="emotes">Emotes</TabsTrigger>
          </TabsList>
          {isOwner && (
            <TabsContent value="overview">
              <Overview guildId={guildId} />
            </TabsContent>
          )}
          <TabsContent value="emotes" className="min-h-0 flex-1">
            <Emotes guildId={guildId} isOwner={isOwner} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Overview({ guildId }: { guildId: string }) {
  const guild = useApp((s) => s.guilds[guildId]);
  const [name, setName] = useState(guild?.name ?? "");
  const [icon, setIcon] = useState(guild?.iconUrl ?? "");
  const save = async () => {
    try {
      const g = await api<Guild>("PATCH", `/guilds/${guildId}`, { name, iconUrl: icon.trim() || null });
      useApp.getState().apply({ t: "GUILD_UPDATE", d: g });
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="max-w-md space-y-4 pt-4">
      <div className="space-y-2">
        <Label>Server name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </div>
      <div className="space-y-2">
        <Label>Icon URL</Label>
        <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="https://…" />
      </div>
      <Button onClick={save}>Save Changes</Button>
    </div>
  );
}

function EmoteImg({ providerId, name, size = 32 }: { providerId: string; name: string; size?: number }) {
  return <img src={emoteUrl(providerId, 1)} srcSet={emoteSrcSet(providerId)} alt={name} title={name} loading="lazy" draggable={false} style={{ height: size }} className="w-auto object-contain" />;
}

function Emotes({ guildId, isOwner }: { guildId: string; isOwner: boolean }) {
  const emotes = useApp(useShallow((s) => s.emotes[guildId] ?? []));
  const [query, setQuery] = useState("");
  const [setId, setSetId] = useState("");
  const [importing, setImporting] = useState(false);
  const q = useDebounced(query.trim(), 300);
  const search = useQuery({
    queryKey: ["7tv", q],
    queryFn: () => api<SevenTvEmote[]>("GET", `/emotes/search?q=${encodeURIComponent(q)}&limit=60`),
    enabled: q.length > 0,
  });
  const have = new Set(emotes.map((e) => e.providerId));

  const add = async (e: SevenTvEmote) => {
    try {
      const emote = await api<Emote>("POST", `/guilds/${guildId}/emotes`, { providerId: e.id });
      useApp.getState().apply({ t: "EMOTE_CREATE", d: emote });
      toast.success(`Added ${emote.name}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const remove = async (e: Emote) => {
    try {
      await api("DELETE", `/guilds/${guildId}/emotes/${e.id}`);
      useApp.getState().apply({ t: "EMOTE_DELETE", d: { id: e.id, guildId } });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const importSet = async () => {
    setImporting(true);
    try {
      const added = await api<Emote[]>("POST", `/guilds/${guildId}/emotes/import`, { setId });
      toast.success(`Imported ${added.length} emotes`);
      setSetId("");
    } catch (err) {
      toast.error((err as Error).message === "not found" ? "Emote set not found" : (err as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-2 gap-4 pt-3">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="text-sm font-semibold">Add from 7TV</div>
        <Input placeholder="Search 7TV emotes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-4 gap-2 overflow-y-auto rounded-md bg-muted p-2">
          {search.isFetching && <Loader2 className="col-span-4 mx-auto animate-spin" />}
          {search.data?.map((e) => (
            <button
              key={e.id}
              disabled={have.has(e.id)}
              onClick={() => add(e)}
              className="group relative flex flex-col items-center gap-1 rounded p-2 hover:bg-accent disabled:opacity-40"
              title={`${e.name}${e.owner ? ` by ${e.owner}` : ""}`}
            >
              <EmoteImg providerId={e.id} name={e.name} />
              <span className="w-full truncate text-center text-[11px] text-muted-foreground">{e.name}</span>
              <Plus className="absolute top-1 right-1 size-3.5 opacity-0 group-hover:opacity-100" />
            </button>
          ))}
          {!q && <p className="col-span-4 p-4 text-center text-sm text-muted-foreground">Search millions of emotes from 7tv.app</p>}
        </div>
        {isOwner && (
          <div className="flex gap-2">
            <Input placeholder="Import 7TV emote set (url or id)" value={setId} onChange={(e) => setSetId(e.target.value)} />
            <Button onClick={importSet} disabled={!setId.trim() || importing}>
              {importing ? <Loader2 className="animate-spin" /> : "Import"}
            </Button>
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        <div className="text-sm font-semibold">Server emotes ({emotes.length})</div>
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-4 gap-2 overflow-y-auto rounded-md bg-muted p-2">
          {emotes.map((e) => (
            <div key={e.id} className="group relative flex flex-col items-center gap-1 rounded p-2 hover:bg-accent">
              <EmoteImg providerId={e.providerId} name={e.name} />
              <span className="w-full truncate text-center text-[11px] text-muted-foreground">{e.name}</span>
              {isOwner && (
                <button onClick={() => remove(e)} className="absolute top-1 right-1 text-destructive opacity-0 group-hover:opacity-100">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
