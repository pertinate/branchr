import type { ReadyGuild } from "@app/protocol";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Compass, MessagesSquare, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RailList } from "@/components/rail-list";
import { UserPanel } from "@/components/voice/user-panel";
import { MentionBadge } from "@/components/mention-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { hubLabel } from "@/lib/hub-names";
import { type Instance, hubBase, instance, instanceKey, useActive, useInstanceList } from "@/lib/instances";
import { isUnread, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";

/** Accepts a bare code or a link like `https://host/app/#/invite/CODE`. */
export function parseInvite(input: string): { code: string; server: string | null } {
  const raw = input.trim();
  try {
    const url = new URL(raw);
    const code = raw.split("/").filter(Boolean).pop() ?? "";
    return { code, server: hubBase(url.href) };
  } catch {
    return { code: raw.split("/").pop() ?? raw, server: null };
  }
}


export function ServerRail() {
  const [open, setOpen] = useState(false);
  return (
    <nav aria-label="Communities" className="relative flex w-[72px] shrink-0 flex-col items-center py-3">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto pb-3">
        <HomeButton />
        <ExploreButton />
        <div className="mx-auto h-0.5 w-8 shrink-0 rounded bg-accent" />
        <RailList />
        <div className="mx-auto h-0.5 w-8 shrink-0 rounded bg-accent" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setOpen(true)}
              aria-label="Add a Community"
              className="grid size-12 shrink-0 place-items-center rounded-3xl bg-background text-online transition-all hover:rounded-2xl hover:bg-online hover:text-white"
            >
              <Plus />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Add a Community</TooltipContent>
        </Tooltip>
      </div>
      <UserPanel />
      <AddServerDialog open={open} onOpenChange={setOpen} />
    </nav>
  );
}

function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const ids = useInstanceList((s) => s.ids);
  const active = useActive((s) => s.id);
  const [target, setTarget] = useState<string | null>(null);
  const on = instance(target && ids.includes(target) ? target : active) ?? instance(ids[0]);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const done = (inst: Instance, g: ReadyGuild) => {
    inst.app.getState().apply({ t: "GUILD_CREATE", d: g });
    onOpenChange(false);
    setName("");
    setInvite("");
    void navigate({ to: "/$guildId", params: { guildId: g.guild.id } });
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!on) return;
    setBusy(true);
    try {
      done(on, await on.api<ReadyGuild>("POST", "/guilds", { name }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInvite(invite);
    // An invite link names its host: use that one if we're connected, else connect first.
    const inst = parsed.server ? instance(instanceKey(parsed.server)) : on;
    if (!inst) {
      onOpenChange(false);
      void navigate({ to: "/login", search: { redirect: undefined, server: parsed.server!, invite: parsed.code } });
      return;
    }
    setBusy(true);
    try {
      done(inst, await inst.api<ReadyGuild>("POST", `/invites/${encodeURIComponent(parsed.code)}`));
    } catch (err) {
      toast.error(
        (err as Error).message === "not found"
          ? `No invite "${parsed.code}" on ${hubLabel(inst.id).name}: it may have expired or been used up. Invites only work on the host that created them.`
          : (err as Error).message,
        { duration: 10_000 },
      );
    } finally {
      setBusy(false);
    }
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    let url = address.trim();
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    onOpenChange(false);
    setAddress("");
    void navigate({ to: "/login", search: { redirect: undefined, server: url } });
  };

  const picker =
    ids.length > 1 && on ? (
      <Select value={on.id} onValueChange={setTarget}>
        <SelectTrigger className="w-full" aria-label="Hub">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ids.map((id) => (
            <SelectItem key={id} value={id}>
              On {hubLabel(id).name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a community</DialogTitle>
          <DialogDescription>Create your own, join one with an invite, or connect to another hub.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="create">
          <TabsList className="w-full">
            <TabsTrigger value="create">Create</TabsTrigger>
            <TabsTrigger value="join">Join</TabsTrigger>
            <TabsTrigger value="connect">Connect</TabsTrigger>
          </TabsList>
          <TabsContent value="create">
            <form onSubmit={create} className="space-y-3 pt-2">
              {picker}
              <Input autoFocus placeholder="Community name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
              <Button type="submit" className="w-full" disabled={busy || !name.trim()}>Create</Button>
            </form>
          </TabsContent>
          <TabsContent value="join">
            <form onSubmit={join} className="space-y-3 pt-2">
              {!parseInvite(invite).server && picker}
              <Input placeholder="Invite code or link" value={invite} onChange={(e) => setInvite(e.target.value)} required />
              <Button type="submit" className="w-full" disabled={busy || !invite.trim()}>Join Community</Button>
            </form>
          </TabsContent>
          <TabsContent value="connect">
            <form onSubmit={connect} className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">Another self-hosted branchr, alongside the ones you're on now.</p>
              <Input placeholder="chat.example.com" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Hub address" required />
              <Button type="submit" className="w-full" disabled={!address.trim()}>Continue</Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Friends and direct messages (on your branchr account), with unread DMs and requests. */
function HomeButton() {
  const active = useRouterState({ select: (s) => s.location.pathname.startsWith("/home") });
  const count = useSocial(
    (s) => Object.values(s.channels).filter((c) => isUnread(c) && c.id !== s.viewing).length + Object.values(s.relationships).filter((r) => r.kind === "incoming").length,
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to="/home" aria-label="Direct Messages" className="group relative flex w-full justify-center">
          <span
            className={cn(
              "absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all",
              active ? "h-10" : "h-0 group-hover:h-5",
            )}
          />
          <div
            className={cn(
              "grid size-12 place-items-center transition-all",
              active ? "rounded-2xl bg-primary text-white" : "rounded-3xl bg-background group-hover:rounded-2xl group-hover:bg-primary group-hover:text-white",
            )}
          >
            <MessagesSquare className="size-6" />
          </div>
          {count > 0 && <MentionBadge count={count} className="absolute right-1 bottom-0 border-4 border-rail" />}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">Direct Messages</TooltipContent>
    </Tooltip>
  );
}

/** Explore: your servers by host, and servers every host chose to list. */
function ExploreButton() {
  const active = useRouterState({ select: (s) => s.location.pathname === "/explore" });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to="/explore" aria-label="Explore" className="group relative flex w-full justify-center">
          <div
            className={cn(
              "grid size-12 place-items-center transition-all",
              active ? "rounded-2xl bg-online text-white" : "rounded-3xl bg-background text-online group-hover:rounded-2xl group-hover:bg-online group-hover:text-white",
            )}
          >
            <Compass className="size-6" />
          </div>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">Explore</TooltipContent>
    </Tooltip>
  );
}
