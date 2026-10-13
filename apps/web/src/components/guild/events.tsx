import type { GuildEvent } from "@app/protocol";
import { CalendarDays, MapPin, Star, Trash2, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useInstance } from "@/lib/instances";
import { P, useCan } from "@/lib/perms";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

/** Loads a community's upcoming events once; the gateway keeps them current after. */
function useEvents(guildId: string): GuildEvent[] | undefined {
  const inst = useInstance();
  const loaded = useApp((s) => !!s.events[guildId]);
  const map = useApp((s) => s.events[guildId]);
  useEffect(() => {
    if (loaded) return;
    inst
      .api<GuildEvent[]>("GET", `/guilds/${guildId}/events`)
      .then((list) => inst.app.getState().setEvents(guildId, list))
      .catch(() => {});
  }, [guildId, inst, loaded]);
  return useMemo(() => (map ? Object.values(map).sort((a, b) => a.startAt - b.startAt) : undefined), [map]);
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Events" in the channel sidebar, with how many are coming up. */
export function EventsRow({ guildId }: { guildId: string }) {
  const events = useEvents(guildId);
  const [open, setOpen] = useState(false);
  const live = events?.some((e) => e.startAt <= Date.now());
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mt-2 flex items-center gap-2 rounded px-2 py-1.5 text-[15px] font-medium text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <CalendarDays className="size-5 opacity-70" />
        <span className="flex-1 text-left">Events</span>
        {!!events?.length && (
          <span className={cn("rounded-full px-1.5 text-xs font-semibold", live ? "bg-online text-white" : "bg-sidebar-accent")} data-testid="event-count">
            {live ? "Live" : events.length}
          </span>
        )}
      </button>
      {open && <EventsDialog guildId={guildId} onClose={() => setOpen(false)} />}
    </>
  );
}

function EventsDialog({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const events = useEvents(guildId);
  const canManage = useCan(guildId, P.MANAGE_EVENTS);
  const [creating, setCreating] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{creating ? "Create Event" : "Events"}</DialogTitle>
          <DialogDescription>{creating ? "Everyone here can see it and say they're interested." : "What's coming up in this community."}</DialogDescription>
        </DialogHeader>
        {creating ? (
          <CreateEvent guildId={guildId} onDone={() => setCreating(false)} />
        ) : (
          <div className="space-y-3">
            {events?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No upcoming events.</p>}
            <div className="max-h-[60vh] space-y-3 overflow-y-auto">
              {events?.map((e) => <EventCard key={e.id} event={e} canManage={canManage} />)}
            </div>
            {canManage && (
              <div className="flex justify-end">
                <Button onClick={() => setCreating(true)}>Create Event</Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EventCard({ event: e, canManage }: { event: GuildEvent; canManage: boolean }) {
  const inst = useInstance();
  const channel = useApp((s) => (e.channelId ? s.channels[e.channelId]?.name : undefined));
  const mine = useApp((s) => s.me?.id === e.creatorId);
  const live = e.startAt <= Date.now();
  const act = async (method: "PUT" | "DELETE", path: string) => {
    try {
      await inst.api(method, `/guilds/${e.guildId}/events/${e.id}${path}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <div className="rounded-lg border border-border p-3" data-testid="event">
      <div className={cn("text-xs font-semibold", live ? "text-online" : "text-primary")}>
        {live ? "Happening now" : when(e.startAt)}
        {e.endAt && ` – ${new Date(e.endAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}
      </div>
      <div className="mt-1 font-semibold break-words">{e.name}</div>
      {(channel || e.location) && (
        <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
          {channel ? <Volume2 className="size-4" /> : <MapPin className="size-4" />}
          {channel ?? e.location}
        </div>
      )}
      {e.description && <p className="mt-2 text-sm whitespace-pre-wrap break-words">{e.description}</p>}
      <div className="mt-3 flex items-center gap-2">
        <span className="flex-1 text-xs text-muted-foreground">{e.interested} interested</span>
        {(mine || canManage) && (
          <Button variant="ghost" size="sm" aria-label="Cancel event" onClick={() => confirm(`Cancel "${e.name}"?`) && void act("DELETE", "")}>
            <Trash2 className="size-4" />
          </Button>
        )}
        <Button variant={e.me ? "default" : "secondary"} size="sm" aria-pressed={e.me} onClick={() => void act(e.me ? "DELETE" : "PUT", "/interest")}>
          <Star className={cn("size-4", e.me && "fill-current")} /> Interested
        </Button>
      </div>
    </div>
  );
}

/** `datetime-local` value for a time, in local time. */
const local = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function CreateEvent({ guildId, onDone }: { guildId: string; onDone: () => void }) {
  const inst = useInstance();
  const voice = useApp(useShallow((s) => Object.values(s.channels).filter((c) => c.guildId === guildId && c.kind === "voice")));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // The next whole hour.
  const [start, setStart] = useState(() => local(Math.ceil(Date.now() / 3_600_000) * 3_600_000));
  const [end, setEnd] = useState("");
  const [where, setWhere] = useState<string>(voice[0]?.id ?? "elsewhere");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    try {
      await inst.api("POST", `/guilds/${guildId}/events`, {
        name,
        description,
        startAt: new Date(start).getTime(),
        endAt: end ? new Date(end).getTime() : null,
        channelId: where === "elsewhere" ? null : where,
        location: where === "elsewhere" ? location || null : null,
      });
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="event-name">Name</Label>
        <Input id="event-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Movie night" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="event-start">Starts</Label>
          <Input id="event-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="event-end">Ends (optional)</Label>
          <Input id="event-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Where</Label>
        <Select value={where} onValueChange={setWhere}>
          <SelectTrigger aria-label="Where">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {voice.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                🔊 {c.name}
              </SelectItem>
            ))}
            <SelectItem value="elsewhere">Somewhere else</SelectItem>
          </SelectContent>
        </Select>
        {where === "elsewhere" && <Input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={100} placeholder="A link, or a place" aria-label="Location" />}
      </div>
      <div className="space-y-2">
        <Label htmlFor="event-description">Description</Label>
        <Textarea id="event-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} className="resize-none" />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Back
        </Button>
        <Button type="submit" disabled={!name.trim() || !start || busy}>
          Create
        </Button>
      </div>
    </form>
  );
}
