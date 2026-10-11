import type { ReadyGuild } from "@app/protocol";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Plus, Volume2 } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { guildInitials } from "@/components/guild/guild-badge";
import { MentionBadge } from "@/components/mention-badge";
import { GuildMenuItems, Menu } from "@/components/menus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { compareIds } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useAuth } from "@/stores/auth";
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
  const guild = useApp((s) => s.guilds[guildId]);
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
  const inVoice = useVoice((s) => s.guildId === guildId);
  if (!guild) return null;
  return (
    <Tooltip>
      <Menu items={<GuildMenuItems guildId={guildId} />}>
      <TooltipTrigger asChild>
        <Link to="/$guildId" params={{ guildId }} aria-label={guild.name} className="group relative flex w-full justify-center">
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
            {guild.iconUrl ? <img src={guild.iconUrl} alt="" className="size-full object-cover" /> : guildInitials(guild.name)}
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

export function ServerRail() {
  const order = useApp((s) => s.guildOrder);
  const params = useParams({ strict: false }) as { guildId?: string };
  const [open, setOpen] = useState(false);
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto py-3">
      {order.map((id) => (
        <GuildIcon key={id} guildId={id} active={params.guildId === id} />
      ))}
      <div className="mx-auto h-0.5 w-8 rounded bg-accent" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setOpen(true)}
            aria-label="Add a Server"
            className="grid size-12 place-items-center rounded-3xl bg-background text-online transition-all hover:rounded-2xl hover:bg-online hover:text-white"
          >
            <Plus />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Add a Server</TooltipContent>
      </Tooltip>
      <AddServerDialog open={open} onOpenChange={setOpen} />
    </nav>
  );
}

function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);

  const done = (g: ReadyGuild) => {
    useApp.getState().apply({ t: "GUILD_CREATE", d: g });
    onOpenChange(false);
    setName("");
    setInvite("");
    void navigate({ to: "/$guildId", params: { guildId: g.guild.id } });
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      done(await api<ReadyGuild>("POST", "/guilds", { name }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const { serverUrl } = useAuth.getState();
    const parsed = parseInvite(invite);
    if (parsed.server && parsed.server !== serverUrl) {
      toast.error(`That invite is for ${parsed.server}, but you're logged in to ${serverUrl}. Log out and sign in to that server to join.`, { duration: 10_000 });
      return;
    }
    setBusy(true);
    try {
      done(await api<ReadyGuild>("POST", `/invites/${encodeURIComponent(parsed.code)}`));
    } catch (err) {
      toast.error(
        (err as Error).message === "not found"
          ? `No invite "${parsed.code}" on ${serverUrl}. Invites only work on the server that created them.`
          : (err as Error).message,
        { duration: 10_000 },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>Create your own or join with an invite.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="create">
          <TabsList className="w-full">
            <TabsTrigger value="create">Create</TabsTrigger>
            <TabsTrigger value="join">Join</TabsTrigger>
          </TabsList>
          <TabsContent value="create">
            <form onSubmit={create} className="space-y-3 pt-2">
              <Input autoFocus placeholder="Server name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
              <Button type="submit" className="w-full" disabled={busy || !name.trim()}>Create</Button>
            </form>
          </TabsContent>
          <TabsContent value="join">
            <form onSubmit={join} className="space-y-3 pt-2">
              <Input placeholder="Invite code or link" value={invite} onChange={(e) => setInvite(e.target.value)} required />
              <Button type="submit" className="w-full" disabled={busy || !invite.trim()}>Join Server</Button>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
