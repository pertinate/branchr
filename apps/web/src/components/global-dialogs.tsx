import type { Channel, Invite, Member } from "@app/protocol";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ChannelPermissions } from "@/components/guild/channel-permissions";
import { CreateThreadDialog } from "@/components/chat/create-thread-dialog";
import { CreateChannelDialog } from "@/components/guild/create-channel-dialog";
import { GuildSettingsDialog } from "@/components/guild/guild-settings-dialog";
import { HostAdminDialog } from "@/components/host-admin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copy } from "@/lib/actions";
import { InstanceProvider, instance, useInstance } from "@/lib/instances";
import { P, useChannelCan } from "@/lib/perms";
import { useApp } from "@/stores/app";
import { type DialogState, useDialogs } from "@/stores/ui";

const SLOWMODES: [number, string][] = [
  [0, "Off"],
  [5, "5 seconds"],
  [10, "10 seconds"],
  [15, "15 seconds"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [120, "2 minutes"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [900, "15 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
  [7200, "2 hours"],
  [21600, "6 hours"],
];

/** Dialogs opened from menus anywhere in the app. Mounted once. */
export function GlobalDialogs() {
  const dialog = useDialogs((s) => s.dialog);
  const close = useDialogs((s) => s.close);
  if (!dialog) return null;
  const inst = instance(dialog.instanceId);
  if (!inst) return null;
  return (
    <InstanceProvider key={inst.id} instance={inst}>
      <DialogFor dialog={dialog} close={close} />
    </InstanceProvider>
  );
}

function DialogFor({ dialog, close }: { dialog: DialogState; close: () => void }) {
  switch (dialog.kind) {
    case "invite":
      return <InviteDialog guildId={dialog.guildId} onClose={close} />;
    case "guild-settings":
      return <GuildSettingsDialog guildId={dialog.guildId} tab={dialog.tab} onClose={close} />;
    case "nickname":
      return <NicknameDialog guildId={dialog.guildId} onClose={close} />;
    case "ban":
      return <BanDialog guildId={dialog.guildId} userId={dialog.userId} onClose={close} />;
    case "create-channel":
      return <CreateChannelDialog guildId={dialog.guildId} parentId={dialog.parentId} open onOpenChange={(o) => !o && close()} />;
    case "edit-channel":
      return <EditChannelDialog channelId={dialog.channelId} onClose={close} />;
    case "create-thread":
      return <CreateThreadDialog channelId={dialog.channelId} messageId={dialog.messageId} suggested={dialog.suggested} onClose={close} />;
    case "host-admin":
      return <HostAdminDialog onClose={close} />;
  }
}

const EXPIRY = [
  { secs: 0, label: "Never" },
  { secs: 1800, label: "30 minutes" },
  { secs: 3600, label: "1 hour" },
  { secs: 86400, label: "1 day" },
  { secs: 604800, label: "7 days" },
];
const USES = [0, 1, 5, 10, 25, 100];

function InviteDialog({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const inst = useInstance();
  const api = inst.api;
  const guild = useApp((s) => s.guilds[guildId]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [maxAge, setMaxAge] = useState("0");
  const [maxUses, setMaxUses] = useState("0");
  // A new invite whenever the options change.
  useEffect(() => {
    setInvite(null);
    api<Invite>("POST", `/guilds/${guildId}/invites`, { maxAge: Number(maxAge), maxUses: Number(maxUses) }).then(setInvite, (e: Error) => {
      toast.error(e.message);
      onClose();
    });
  }, [guildId, onClose, maxAge, maxUses]);
  const link = invite ? `${inst.url}/#/invite/${invite.code}` : "";
  const vanity = guild?.vanityCode ? `${inst.url}/#/invite/${guild.vanityCode}` : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite friends to {guild?.name}</DialogTitle>
          <DialogDescription>Friends paste this in "Add a Server → Join". Invites only work on this server, so the link includes it.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={invite?.code ?? ""} placeholder="Creating…" className="font-mono" aria-label="Invite code" />
          <Button disabled={!invite} onClick={() => void copy(link, "Copied invite link")}>
            <Copy /> Copy link
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="invite-expiry">Expire after</Label>
            <Select value={maxAge} onValueChange={setMaxAge}>
              <SelectTrigger id="invite-expiry" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY.map((e) => (
                  <SelectItem key={e.secs} value={String(e.secs)}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-uses">Max uses</Label>
            <Select value={maxUses} onValueChange={setMaxUses}>
              <SelectTrigger id="invite-uses" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {USES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n === 0 ? "No limit" : n === 1 ? "1 use" : `${n} uses`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {vanity && (
          <p className="text-sm text-muted-foreground">
            Or share the branch's own link:{" "}
            <button className="font-mono text-primary hover:underline" onClick={() => void copy(vanity, "Copied invite link")}>
              {guild!.vanityCode}
            </button>
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NicknameDialog({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const inst = useInstance();
  const api = inst.api;
  const guild = useApp((s) => s.guilds[guildId]);
  const me = useApp((s) => (s.me ? s.members[guildId]?.[s.me.id] : undefined));
  const [nick, setNick] = useState(me?.nick ?? "");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const m = await api<Member>("PATCH", `/guilds/${guildId}/members/@me`, { nick: nick.trim() || null });
      inst.app.getState().apply({ t: "MEMBER_UPDATE", d: m });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change Nickname</DialogTitle>
          <DialogDescription>Only in {guild?.name}. Leave it empty to use your display name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <Input autoFocus value={nick} onChange={(e) => setNick(e.target.value)} maxLength={32} placeholder={me?.user.displayName} aria-label="Nickname" />
          <div className="flex justify-end gap-2">
            {me?.nick && (
              <Button type="button" variant="ghost" onClick={() => setNick("")}>
                Reset
              </Button>
            )}
            <Button type="submit">Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const DELETE_HISTORY = [
  { hours: 0, label: "Don't delete any" },
  { hours: 1, label: "Previous hour" },
  { hours: 24, label: "Previous 24 hours" },
  { hours: 168, label: "Previous 7 days" },
];

function BanDialog({ guildId, userId, onClose }: { guildId: string; userId: string; onClose: () => void }) {
  const inst = useInstance();
  const member = useApp((s) => s.members[guildId]?.[userId]);
  const guild = useApp((s) => s.guilds[guildId]);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState("0");
  const name = member ? (member.nick ?? member.user.displayName) : "them";
  const ban = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await inst.api("PUT", `/guilds/${guildId}/bans/${userId}`, { reason: reason.trim() || null, deleteMessageHours: Number(hours) });
      toast.success(`Banned ${name}`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Ban {name}</DialogTitle>
          <DialogDescription>They're removed from {guild?.name} and can't rejoin, even with an invite, until unbanned.</DialogDescription>
        </DialogHeader>
        <form onSubmit={ban} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ban-history">Delete message history</Label>
            <Select value={hours} onValueChange={setHours}>
              <SelectTrigger id="ban-history" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELETE_HISTORY.map((d) => (
                  <SelectItem key={d.hours} value={String(d.hours)}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ban-reason">Reason</Label>
            <Input id="ban-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={512} placeholder="Shown in the ban list and audit log" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive">
              Ban
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditChannelDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const inst = useInstance();
  const api = inst.api;
  const channel = useApp((s) => s.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [slowmode, setSlowmode] = useState(String(channel?.slowmodeSecs ?? 0));
  const canPerms = useChannelCan(channelId, P.MANAGE_ROLES);
  if (!channel) return null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await api<Channel>("PATCH", `/channels/${channelId}`, {
        name: name.trim(),
        ...(channel.kind === "text" ? { topic: topic.trim() || null, slowmodeSecs: Number(slowmode) } : {}),
      });
      inst.app.getState().apply({ t: "CHANNEL_UPDATE", d: c });
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const form = (
    <form onSubmit={save} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="channel-name">Name</Label>
        <Input id="channel-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      </div>
      {channel.kind === "text" && (
        <div className="space-y-1">
          <Label htmlFor="channel-topic">Topic</Label>
          <Input id="channel-topic" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={1024} placeholder="What's this channel about?" />
        </div>
      )}
      {channel.kind === "text" && (
        <div className="space-y-1">
          <Label htmlFor="channel-slowmode">Slow mode</Label>
          <Select value={slowmode} onValueChange={setSlowmode}>
            <SelectTrigger id="channel-slowmode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SLOWMODES.map(([secs, label]) => (
                <SelectItem key={secs} value={String(secs)}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">How long members wait between messages. People who can manage messages or the channel aren't limited.</p>
        </div>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={canPerms ? "flex h-[80vh] flex-col sm:max-w-3xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>Edit {channel.kind === "category" ? "Category" : "Channel"}</DialogTitle>
        </DialogHeader>
        {canPerms ? (
          <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="permissions">Permissions</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="max-w-md pt-3">
              {form}
            </TabsContent>
            <TabsContent value="permissions" className="min-h-0 flex-1">
              <ChannelPermissions channel={channel} />
            </TabsContent>
          </Tabs>
        ) : (
          form
        )}
      </DialogContent>
    </Dialog>
  );
}
