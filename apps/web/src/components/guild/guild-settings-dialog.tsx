import type { Emote, EmoteImport, EmoteProvider, ExternalEmote, Guild } from "@app/protocol";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebounced } from "@/hooks/use-debounced";
import { AuditLogSettings, BansSettings } from "@/components/guild/moderation-settings";
import { RolesSettings } from "@/components/guild/roles-settings";
import { PicturePicker } from "@/components/picture-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { uploadPicture } from "@/lib/media";
import { useInstance } from "@/lib/instances";
import { P, useCan } from "@/lib/perms";
import { type EmoteSource, emoteSource, emoteSrcSet, emoteUrl, providerNames } from "@/lib/emotes";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

type Tab = "overview" | "roles" | "emotes" | "bans" | "audit";

export function GuildSettingsDialog({ guildId, tab, onClose }: { guildId: string; tab: Tab; onClose: () => void }) {
  const canGuild = useCan(guildId, P.MANAGE_GUILD);
  const canRoles = useCan(guildId, P.MANAGE_ROLES);
  const canEmotes = useCan(guildId, P.MANAGE_EMOTES);
  const canBans = useCan(guildId, P.BAN_MEMBERS);
  const canAudit = useCan(guildId, P.VIEW_AUDIT_LOG);
  const allowed: Record<Tab, boolean> = { overview: canGuild, roles: canRoles, emotes: true, bans: canBans, audit: canAudit };
  const first = allowed[tab] ? tab : canGuild ? "overview" : canRoles ? "roles" : "emotes";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Server Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={first} className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            {canGuild && <TabsTrigger value="overview">Overview</TabsTrigger>}
            {canRoles && <TabsTrigger value="roles">Roles</TabsTrigger>}
            <TabsTrigger value="emotes">Emotes</TabsTrigger>
            {canBans && <TabsTrigger value="bans">Bans</TabsTrigger>}
            {canAudit && <TabsTrigger value="audit">Audit Log</TabsTrigger>}
          </TabsList>
          {canGuild && (
            <TabsContent value="overview">
              <Overview guildId={guildId} />
            </TabsContent>
          )}
          {canRoles && (
            <TabsContent value="roles" className="min-h-0 flex-1">
              <RolesSettings guildId={guildId} />
            </TabsContent>
          )}
          <TabsContent value="emotes" className="min-h-0 flex-1">
            <Emotes guildId={guildId} canManage={canEmotes} />
          </TabsContent>
          {canBans && (
            <TabsContent value="bans" className="min-h-0 flex-1">
              <BansSettings guildId={guildId} />
            </TabsContent>
          )}
          {canAudit && (
            <TabsContent value="audit" className="min-h-0 flex-1">
              <AuditLogSettings guildId={guildId} />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Overview({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const api = inst.api;
  const guild = useApp((s) => s.guilds[guildId]);
  const [name, setName] = useState(guild?.name ?? "");
  const [description, setDescription] = useState(guild?.description ?? "");
  const [vanity, setVanity] = useState(guild?.vanityCode ?? "");
  const [system, setSystem] = useState(guild?.systemChannelId ?? "none");
  const textChannels = useApp(useShallow((s) => Object.values(s.channels).filter((c) => c.guildId === guildId && c.kind === "text")));
  const applied = (g: Guild) => inst.app.getState().apply({ t: "GUILD_UPDATE", d: g });
  const save = async () => {
    try {
      applied(
        await api<Guild>("PATCH", `/guilds/${guildId}`, {
          name,
          description,
          vanityCode: vanity.trim() || null,
          systemChannelId: system === "none" ? null : system,
        }),
      );
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="max-w-md space-y-4 overflow-y-auto pt-4">
      <div className="flex flex-wrap gap-8">
        <PicturePicker
          label="Server icon"
          shape="square"
          url={guild?.iconUrl}
          hint="Cropped to a square."
          onUpload={async (f) => applied(await uploadPicture<Guild>(inst, `/guilds/${guildId}/icon`, f))}
          onRemove={async () => applied(await api<Guild>("DELETE", `/guilds/${guildId}/icon`))}
        />
        <PicturePicker
          label="Banner"
          shape="banner"
          url={guild?.bannerUrl}
          hint="Shown above the channel list."
          onUpload={async (f) => applied(await uploadPicture<Guild>(inst, `/guilds/${guildId}/banner`, f))}
          onRemove={async () => applied(await api<Guild>("DELETE", `/guilds/${guildId}/banner`))}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="guild-name">Server name</Label>
        <Input id="guild-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="guild-description">Description</Label>
        <Textarea id="guild-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={3} placeholder="What's this server about?" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="system-channel">Join messages</Label>
        <Select value={system} onValueChange={setSystem}>
          <SelectTrigger id="system-channel" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Don't post join messages</SelectItem>
            {textChannels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                #{c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="vanity-code">Vanity invite code</Label>
        <Input id="vanity-code" value={vanity} onChange={(e) => setVanity(e.target.value)} maxLength={32} placeholder="my-server" className="font-mono" />
        <p className="text-xs text-muted-foreground">A permanent invite anyone can use, like {inst.url}/#/invite/my-server.</p>
      </div>
      <Button onClick={save}>Save Changes</Button>
    </div>
  );
}

function EmoteImg({ source, name, size = 32 }: { source: EmoteSource; name: string; size?: number }) {
  return <img src={emoteUrl(source, 1)} srcSet={emoteSrcSet(source)} alt={name} title={name} loading="lazy" draggable={false} style={{ height: size }} className="w-auto object-contain" />;
}

/** Providers with a public search API (BetterTTV's needs a logged-in site session). */
const SEARCHABLE: EmoteProvider[] = ["7tv", "ffz"];

function Emotes({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const inst = useInstance();
  const api = inst.api;
  const emotes = useApp(useShallow((s) => s.emotes[guildId] ?? []));
  const [provider, setProvider] = useState<EmoteProvider>("7tv");
  const [query, setQuery] = useState("");
  const [link, setLink] = useState("");
  const [linkName, setLinkName] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState<EmoteProvider[]>(["7tv", "bttv", "ffz"]);
  const [busy, setBusy] = useState<"link" | "import" | null>(null);
  const [filter, setFilter] = useState("");
  const [clash, setClash] = useState<{ emote: ExternalEmote; name: string } | null>(null);
  const q = useDebounced(query.trim(), 300);
  const search = useQuery({
    queryKey: ["emote-search", provider, q],
    queryFn: () => api<ExternalEmote[]>("GET", `/emotes/search?provider=${provider}&q=${encodeURIComponent(q)}&limit=60`),
    enabled: q.length > 0,
  });
  const have = new Set(emotes.map((e) => `${e.provider}:${e.providerId}`));
  const shown = filter ? emotes.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase())) : emotes;
  const isLinkBttv = /betterttv\.(com|net)/i.test(link);

  const added = (emote: Emote) => {
    inst.app.getState().apply({ t: "EMOTE_CREATE", d: emote });
    toast.success(`Added ${emote.name}`);
  };

  const add = async (e: ExternalEmote, name?: string) => {
    try {
      added(await api<Emote>("POST", `/guilds/${guildId}/emotes`, { provider: e.provider, providerId: e.id, name }));
      setClash(null);
    } catch (err) {
      // Name taken: ask for another one instead of failing.
      if (emotes.some((x) => x.name === (name ?? e.name))) setClash({ emote: e, name: `${name ?? e.name}2` });
      else toast.error((err as Error).message);
    }
  };

  const addLink = async () => {
    setBusy("link");
    try {
      added(await api<Emote>("POST", `/guilds/${guildId}/emotes`, { url: link.trim(), name: linkName.trim() || null }));
      setLink("");
      setLinkName("");
    } catch (err) {
      toast.error((err as Error).message === "not found" ? "Emote not found" : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (e: Emote) => {
    try {
      await api("DELETE", `/guilds/${guildId}/emotes/${e.id}`);
      inst.app.getState().apply({ t: "EMOTE_DELETE", d: { id: e.id, guildId } });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const importSet = async () => {
    setBusy("import");
    try {
      const r = await api<EmoteImport>("POST", `/guilds/${guildId}/emotes/import`, { source: source.trim(), providers: from });
      const skipped = r.found - r.added.length;
      toast.success(`Imported ${r.added.length} emotes${skipped ? ` (${skipped} skipped: name taken, invalid, or limit reached)` : ""}`);
      setSource("");
    } catch (err) {
      toast.error((err as Error).message === "not found" ? "No emotes found there" : (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleFrom = (p: EmoteProvider) => setFrom((f) => (f.includes(p) ? f.filter((x) => x !== p) : [...f, p]));

  return (
    <div className={cn("grid h-full min-h-0 gap-4 pt-3", canManage ? "grid-cols-2" : "grid-cols-1")}>
      {canManage && (
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Search</div>
            <div className="flex rounded-md bg-muted p-0.5 text-xs" role="tablist" aria-label="Emote provider">
              {SEARCHABLE.map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={provider === p}
                  onClick={() => setProvider(p)}
                  className={cn("rounded px-2 py-0.5", provider === p ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                >
                  {providerNames[p]}
                </button>
              ))}
            </div>
          </div>
          <Input placeholder={`Search ${providerNames[provider]} emotes…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-4 gap-2 overflow-y-auto rounded-md bg-muted p-2" data-testid="emote-results">
            {search.isFetching && <Loader2 className="col-span-4 mx-auto animate-spin" />}
            {search.isError && <p className="col-span-4 p-4 text-center text-sm text-destructive">{(search.error as Error).message}</p>}
            {search.data?.map((e) => (
              <button
                key={e.id}
                disabled={have.has(`${e.provider}:${e.id}`)}
                onClick={() => add(e)}
                className="group relative flex flex-col items-center gap-1 rounded p-2 hover:bg-accent disabled:opacity-40"
                title={`${e.name}${e.owner ? ` by ${e.owner}` : ""}`}
              >
                <EmoteImg source={e} name={e.name} />
                <span className="w-full truncate text-center text-[11px] text-muted-foreground">{e.name}</span>
                <Plus className="absolute top-1 right-1 size-3.5 opacity-0 group-hover:opacity-100" />
              </button>
            ))}
            {search.data?.length === 0 && <p className="col-span-4 p-4 text-center text-sm text-muted-foreground">No results</p>}
            {!q && (
              <p className="col-span-4 p-4 text-center text-sm text-muted-foreground">
                Search {providerNames[provider]}, or paste a link from 7TV, BetterTTV or FrankerFaceZ below.
              </p>
            )}
          </div>
          {clash && (
            <form
              className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
              onSubmit={(ev) => {
                ev.preventDefault();
                void add(clash.emote, clash.name.trim());
              }}
            >
              <EmoteImg source={clash.emote} name={clash.emote.name} size={24} />
              <span className="shrink-0">{clash.emote.name} is taken. Add as</span>
              <Input
                autoFocus
                className="h-7 text-xs"
                value={clash.name}
                onChange={(ev) => setClash({ ...clash, name: ev.target.value })}
                aria-label="New emote name"
              />
              <Button size="sm" type="submit" disabled={!clash.name.trim()}>
                Add
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setClash(null)}>
                Cancel
              </Button>
            </form>
          )}
          <div className="flex gap-2">
            <Input placeholder="Emote link (7TV, BetterTTV, FFZ)" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Emote link" />
            <Input
              className="w-32"
              placeholder={isLinkBttv ? "Name (required)" : "Name (optional)"}
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
              aria-label="Emote name"
            />
            <Button onClick={addLink} disabled={!link.trim() || (isLinkBttv && !linkName.trim()) || busy !== null}>
              {busy === "link" ? <Loader2 className="animate-spin" /> : "Add"}
            </Button>
          </div>
          <div className="space-y-1.5 rounded-md border p-2">
            <div className="flex gap-2">
              <Input
                placeholder="Twitch channel, 7TV set/user link, or FFZ channel link"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                aria-label="Import source"
              />
              <Button onClick={importSet} disabled={!source.trim() || from.length === 0 || busy !== null}>
                {busy === "import" ? <Loader2 className="animate-spin" /> : "Import"}
              </Button>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>From a Twitch channel:</span>
              {(["7tv", "bttv", "ffz"] as const).map((p) => (
                <label key={p} className="flex items-center gap-1">
                  <input type="checkbox" checked={from.includes(p)} onChange={() => toggleFrom(p)} className="accent-primary" />
                  {providerNames[p]}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="shrink-0 text-sm font-semibold">Server emotes ({emotes.length})</div>
          <Input className="h-7 max-w-40 text-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-4 gap-2 overflow-y-auto rounded-md bg-muted p-2" data-testid="server-emotes">
          {shown.map((e) => (
            <div key={e.id} className="group relative flex flex-col items-center gap-1 rounded p-2 hover:bg-accent" title={`${e.name} · ${providerNames[e.provider]}`}>
              <EmoteImg source={emoteSource(e)} name={e.name} />
              <EmoteName emote={e} guildId={guildId} canEdit={canManage} />
              <span className="absolute top-1 left-1 text-[9px] font-semibold text-muted-foreground uppercase opacity-0 group-hover:opacity-100">{e.provider}</span>
              {canManage && (
                <button onClick={() => remove(e)} aria-label={`Remove ${e.name}`} className="absolute top-1 right-1 text-destructive opacity-0 group-hover:opacity-100">
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

/** The emote's name in this server; owners click it to rename (e.g. to fix a clash). */
function EmoteName({ emote, guildId, canEdit }: { emote: Emote; guildId: string; canEdit: boolean }) {
  const inst = useInstance();
  const api = inst.api;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(emote.name);
  const save = async () => {
    const name = value.trim();
    setEditing(false);
    if (!name || name === emote.name) return setValue(emote.name);
    try {
      const updated = await api<Emote>("PATCH", `/guilds/${guildId}/emotes/${emote.id}`, { name });
      inst.app.getState().apply({ t: "EMOTE_UPDATE", d: updated });
    } catch (err) {
      setValue(emote.name);
      toast.error((err as Error).message);
    }
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={64}
        aria-label={`Rename ${emote.name}`}
        onChange={(ev) => setValue(ev.target.value)}
        onBlur={save}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") ev.currentTarget.blur();
          if (ev.key === "Escape") {
            ev.stopPropagation(); // keep the dialog open
            setValue(emote.name);
            setEditing(false);
          }
        }}
        className="w-full rounded bg-background px-1 text-center text-[11px] outline-none ring-1 ring-ring"
      />
    );
  }
  return canEdit ? (
    <button
      onClick={() => {
        setValue(emote.name);
        setEditing(true);
      }}
      className="flex w-full items-center justify-center gap-0.5 truncate text-center text-[11px] text-muted-foreground hover:text-foreground"
      title="Rename"
    >
      <span className="truncate">{emote.name}</span>
      <Pencil className="size-2.5 shrink-0 opacity-0 group-hover:opacity-100" />
    </button>
  ) : (
    <span className="w-full truncate text-center text-[11px] text-muted-foreground">{emote.name}</span>
  );
}
