import type { HostGuild, HostOverview, HostUser } from "@app/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Search, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserAvatar } from "@/components/user-avatar";
import { type Instance, hostOf, useInstance } from "@/lib/instances";
import { formatBytes } from "@/lib/upload";

/** Whether we own (claimed) `inst`: its admin overview answers only for the owner. */
export function useHostOwner(inst: Instance) {
  const q = useQuery({
    queryKey: ["host-overview", inst.id],
    queryFn: () => inst.api<HostOverview>("GET", "/admin/overview").catch(() => null),
    staleTime: 60_000,
  });
  return !!q.data;
}

/** Manage a host you've claimed: settings, people, servers. Rendered in its instance's provider. */
export function HostAdminDialog({ onClose }: { onClose: () => void }) {
  const inst = useInstance();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[75vh] flex-col sm:max-w-3xl" data-testid="host-admin">
        <DialogHeader>
          <DialogTitle>Manage {hostOf(inst.url)}</DialogTitle>
          <DialogDescription>You claimed this host, so you can change its settings, ban people and remove servers.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="servers">Servers</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="overflow-y-auto">
            <Overview />
          </TabsContent>
          <TabsContent value="members" className="min-h-0 overflow-y-auto">
            <Members />
          </TabsContent>
          <TabsContent value="servers" className="min-h-0 overflow-y-auto">
            <Servers />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-muted p-3">
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function Overview() {
  const inst = useInstance();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["host-overview", inst.id], queryFn: () => inst.api<HostOverview>("GET", "/admin/overview") });
  if (!q.data) return <p className="pt-4 text-sm text-muted-foreground">{q.isError ? (q.error as Error).message : "Loading…"}</p>;
  const o = q.data;
  const setOpen = async (openRegistration: boolean) => {
    try {
      qc.setQueryData(["host-overview", inst.id], await inst.api<HostOverview>("PATCH", "/admin/settings", { openRegistration }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const signIn = o.authMode === "both" ? "Discord or a password" : o.authMode === "federated" ? "Discord only" : "Passwords only";
  return (
    <div className="space-y-5 pt-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="People" value={o.users} />
        <Stat label="Servers" value={o.guilds} />
        <Stat label="Messages" value={o.messages.toLocaleString()} />
        <Stat label="Files" value={formatBytes(o.attachmentBytes)} />
      </div>
      <div className="space-y-1 text-sm">
        <div>
          <span className="text-muted-foreground">Name: </span>
          {o.name}
        </div>
        <div>
          <span className="text-muted-foreground">Sign-in: </span>
          {signIn}
        </div>
        <div>
          <span className="text-muted-foreground">Banned: </span>
          {o.banned}
        </div>
      </div>
      <div className="flex max-w-md items-start justify-between gap-4 border-t border-border pt-4">
        <div>
          <Label htmlFor="open-registration">Open registration</Label>
          <p className="mt-1 text-xs text-muted-foreground">When off, only people who already have an account here can log in.</p>
        </div>
        <Switch id="open-registration" checked={o.openRegistration} onCheckedChange={(v) => void setOpen(v)} />
      </div>
    </div>
  );
}

function Members() {
  const inst = useInstance();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [bannedOnly, setBannedOnly] = useState(false);
  const key = ["host-users", inst.id, q, bannedOnly];
  const users = useQuery({
    queryKey: key,
    queryFn: () => inst.api<HostUser[]>("GET", `/admin/users?q=${encodeURIComponent(q)}${bannedOnly ? "&banned=true" : ""}`),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["host-users", inst.id] });
    void qc.invalidateQueries({ queryKey: ["host-overview", inst.id] });
  };
  const ban = async (u: HostUser) => {
    const reason = prompt(`Ban ${u.user.displayName} (@${u.user.username}) from ${hostOf(inst.url)}? They're logged out and can't come back.\n\nReason (optional):`);
    if (reason === null) return;
    try {
      await inst.api("PUT", `/admin/bans/${u.user.id}`, { reason });
      toast.success(`Banned ${u.user.displayName}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const unban = async (u: HostUser) => {
    try {
      await inst.api("DELETE", `/admin/bans/${u.user.id}`);
      toast.success(`Unbanned ${u.user.displayName}`);
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="space-y-3 pt-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="pl-8" aria-label="Search people" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={bannedOnly} onCheckedChange={setBannedOnly} aria-label="Banned only" /> Banned only
        </label>
      </div>
      <div className="divide-y divide-border">
        {users.data?.map((u) => (
          <div key={u.user.id} data-testid="host-user" className="flex items-center gap-3 py-2">
            <UserAvatar user={u.user} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium">{u.user.displayName}</span>
                {u.owner && (
                  <Badge variant="secondary">
                    <ShieldCheck /> Owner
                  </Badge>
                )}
                {u.linked && !u.owner && <Badge variant="outline">branchr</Badge>}
                {u.banned && <Badge variant="destructive">Banned</Badge>}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                @{u.user.username} · {u.guilds} server{u.guilds === 1 ? "" : "s"} · joined {new Date(u.createdAt).toLocaleDateString()}
                {u.banReason && ` · "${u.banReason}"`}
              </div>
            </div>
            {!u.owner &&
              (u.banned ? (
                <Button size="sm" variant="outline" onClick={() => void unban(u)}>
                  <Undo2 /> Unban
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={() => void ban(u)}>
                  <Ban /> Ban
                </Button>
              ))}
          </div>
        ))}
        {users.data?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nobody matches.</p>}
      </div>
    </div>
  );
}

function Servers() {
  const inst = useInstance();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const guilds = useQuery({ queryKey: ["host-guilds", inst.id, q], queryFn: () => inst.api<HostGuild[]>("GET", `/admin/guilds?q=${encodeURIComponent(q)}`) });
  const remove = async (g: HostGuild) => {
    if (!confirm(`Delete "${g.guild.name}" (owned by @${g.owner.username}, ${g.members} members)? All its channels and messages are deleted. This can't be undone.`)) return;
    try {
      await inst.api("DELETE", `/admin/guilds/${g.guild.id}`);
      toast.success(`Deleted ${g.guild.name}`);
      void qc.invalidateQueries({ queryKey: ["host-guilds", inst.id] });
      void qc.invalidateQueries({ queryKey: ["host-overview", inst.id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="space-y-3 pt-4">
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search servers" className="pl-8" aria-label="Search servers" />
      </div>
      <div className="divide-y divide-border">
        {guilds.data?.map((g) => (
          <div key={g.guild.id} data-testid="host-guild" className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{g.guild.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                Owner @{g.owner.username} · {g.members} member{g.members === 1 ? "" : "s"} · {g.channels} channels
              </div>
            </div>
            <Button size="sm" variant="destructive" onClick={() => void remove(g)} aria-label={`Delete ${g.guild.name}`}>
              <Trash2 /> Delete
            </Button>
          </div>
        ))}
        {guilds.data?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No servers.</p>}
      </div>
    </div>
  );
}
