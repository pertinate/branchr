import type { ReadyGuild } from "@app/protocol";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Copy, LogOut, Plus, Settings, Volume2 } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { UserPanel } from "@/components/voice/user-panel";
import { guildInitials } from "@/components/guild/guild-badge";
import { useHostOwner } from "@/components/host-admin-dialog";
import { MentionBadge } from "@/components/mention-badge";
import { GuildMenuItems, Menu } from "@/components/menus";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copy } from "@/lib/actions";
import { forgetHost } from "@/lib/host-sync";
import { compareIds } from "@/lib/ids";
import { type Instance, InstanceProvider, hostOf, instance, instanceKey, useActive, useInstance, useInstanceList } from "@/lib/instances";
import { useMediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/ui";
import { useVoice } from "@/stores/voice";

/** Accepts a bare code or a link like `https://host/#/invite/CODE`. */
export function parseInvite(input: string): { code: string; server: string | null } {
  const raw = input.trim();
  try {
    const url = new URL(raw);
    const code = raw.split("/").filter(Boolean).pop() ?? "";
    return { code, server: url.origin };
  } catch {
    return { code: raw.split("/").pop() ?? raw, server: null };
  }
}


const GuildIcon = memo(function GuildIcon({ guildId, active }: { guildId: string; active: boolean }) {
  const instanceId = useInstance().id;
  const guild = useApp((s) => s.guilds[guildId]);
  const icon = useMediaUrl(guild?.iconUrl);
  const unread = useApp((s) =>
    Object.values(s.channels).some(
      (c) =>
        c.guildId === guildId &&
        c.kind === "text" &&
        c.lastMessageId &&
        (!s.lastRead[c.id] || compareIds(c.lastMessageId, s.lastRead[c.id]) > 0),
    ),
  );
  const pings = useApp((s) => {
    let n = 0;
    for (const [cid, count] of Object.entries(s.pings)) if (s.channels[cid]?.guildId === guildId) n += count;
    return n;
  });
  const inVoice = useVoice((s) => s.guildId === guildId && s.instanceId === instanceId);
  if (!guild) return null;
  return (
    <Tooltip>
      <Menu items={<GuildMenuItems guildId={guildId} />}>
      <TooltipTrigger asChild>
        <Link to="/$instance/$guildId" params={{ instance: instanceId, guildId }} aria-label={guild.name} className="group relative flex w-full justify-center">
          <span
            className={cn(
              "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all",
              active ? "h-10" : unread ? "h-2 group-hover:h-5" : "h-0 group-hover:h-5",
            )}
          />
          <div
            className={cn(
              "grid size-12 place-items-center overflow-hidden text-sm font-semibold transition-all",
              active ? "rounded-2xl bg-primary text-white" : "rounded-3xl bg-background group-hover:rounded-2xl group-hover:bg-primary group-hover:text-white",
            )}
          >
            {icon ? <img src={icon} alt="" className="size-full object-cover" /> : guildInitials(guild.name)}
          </div>
          {pings > 0 && <MentionBadge count={pings} className="absolute right-1 bottom-0 border-4 border-rail" />}
          {inVoice && !pings && (
            <span className="absolute -right-0 bottom-0 grid size-5 place-items-center rounded-full border-4 border-rail bg-online">
              <Volume2 className="size-2.5 text-white" />
            </span>
          )}
        </Link>
      </TooltipTrigger>
      </Menu>
      <TooltipContent side="right">{guild.name}</TooltipContent>
    </Tooltip>
  );
});

/** Labels one instance's group in the rail when there's more than one. */
function InstanceHeader() {
  const inst = useInstance();
  const connection = useApp((s) => s.connection);
  const navigate = useNavigate();
  const host = hostOf(inst.url);
  const label = host.split(".")[0].split(":")[0];
  const owner = useHostOwner(inst);
  return (
    <Tooltip>
      <Menu
        items={
          <>
            <ContextMenuLabel className="truncate">{host}</ContextMenuLabel>
            {owner && (
              <ContextMenuItem onSelect={() => useDialogs.getState().open({ instanceId: inst.id, kind: "host-admin" })}>
                Manage Host <Settings className="ml-auto" />
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => void copy(inst.url, "Copied address")}>
              Copy Address <Copy className="ml-auto" />
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => {
                if (!confirm(`Log out of ${host}? Your other hosts stay connected.`)) return;
                forgetHost(inst.url);
                void inst.api("POST", "/auth/logout").catch(() => {});
                inst.auth.getState().logout();
                void navigate({ to: "/" });
              }}
            >
              Log Out of {host} <LogOut className="ml-auto" />
            </ContextMenuItem>
          </>
        }
      >
        <TooltipTrigger asChild>
          <div
            data-testid="instance-header"
            data-instance={inst.id}
            className="flex w-14 cursor-default items-center justify-center gap-1 truncate rounded px-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", connection === "ready" ? "bg-online" : "bg-idle")} />
            <span className="truncate">{label}</span>
          </div>
        </TooltipTrigger>
      </Menu>
      <TooltipContent side="right">
        {host}
        {connection !== "ready" && " (connecting…)"}
      </TooltipContent>
    </Tooltip>
  );
}

function InstanceGuilds({ activeGuild }: { activeGuild: string | undefined }) {
  const order = useApp((s) => s.guildOrder);
  return (
    <>
      {order.map((id) => (
        <GuildIcon key={id} guildId={id} active={activeGuild === id} />
      ))}
    </>
  );
}

export function ServerRail() {
  const ids = useInstanceList((s) => s.ids);
  const params = useParams({ strict: false }) as { instance?: string; guildId?: string };
  const [open, setOpen] = useState(false);
  return (
    <nav aria-label="Servers" className="relative flex w-[72px] shrink-0 flex-col items-center py-3">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto pb-3">
        {ids.map((id, i) => {
          const inst = instance(id);
          if (!inst) return null;
          return (
            <InstanceProvider key={id} instance={inst}>
              {i > 0 && <div className="mx-auto h-0.5 w-8 shrink-0 rounded bg-accent" />}
              {ids.length > 1 && <InstanceHeader />}
              <InstanceGuilds activeGuild={params.instance === id ? params.guildId : undefined} />
            </InstanceProvider>
          );
        })}
        <div className="mx-auto h-0.5 w-8 shrink-0 rounded bg-accent" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setOpen(true)}
              aria-label="Add a Server"
              className="grid size-12 shrink-0 place-items-center rounded-3xl bg-background text-online transition-all hover:rounded-2xl hover:bg-online hover:text-white"
            >
              <Plus />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Add a Server</TooltipContent>
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
    void navigate({ to: "/$instance/$guildId", params: { instance: inst.id, guildId: g.guild.id } });
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
          ? `No invite "${parsed.code}" on ${hostOf(inst.url)}: it may have expired or been used up. Invites only work on the host that created them.`
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
        <SelectTrigger className="w-full" aria-label="Host">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ids.map((id) => (
            <SelectItem key={id} value={id}>
              On {hostOf(instance(id)?.url ?? id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>Create your own, join with an invite, or connect to another branchr host.</DialogDescription>
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
              <Input autoFocus placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
              <Button type="submit" className="w-full" disabled={busy || !name.trim()}>Create</Button>
            </form>
          </TabsContent>
          <TabsContent value="join">
            <form onSubmit={join} className="space-y-3 pt-2">
              {!parseInvite(invite).server && picker}
              <Input placeholder="Invite code or link" value={invite} onChange={(e) => setInvite(e.target.value)} required />
              <Button type="submit" className="w-full" disabled={busy || !invite.trim()}>Join Server</Button>
            </form>
          </TabsContent>
          <TabsContent value="connect">
            <form onSubmit={connect} className="space-y-3 pt-2">
              <p className="text-sm text-muted-foreground">Another self-hosted branchr, alongside the ones you're on now.</p>
              <Input placeholder="chat.example.com" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Host address" required />
              <Button type="submit" className="w-full" disabled={!address.trim()}>Continue</Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
