import type { Channel, Invite, Member } from "@app/protocol";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ChannelPermissions } from "@/components/guild/channel-permissions";
import { CreateChannelDialog } from "@/components/guild/create-channel-dialog";
import { GuildSettingsDialog } from "@/components/guild/guild-settings-dialog";
import { HostAdminDialog } from "@/components/host-admin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copy } from "@/lib/actions";
import { InstanceProvider, instance, useInstance } from "@/lib/instances";
import { P, useChannelCan } from "@/lib/perms";
import { useApp } from "@/stores/app";
import { type DialogState, useDialogs } from "@/stores/ui";

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
    case "create-channel":
      return <CreateChannelDialog guildId={dialog.guildId} parentId={dialog.parentId} open onOpenChange={(o) => !o && close()} />;
    case "edit-channel":
      return <EditChannelDialog channelId={dialog.channelId} onClose={close} />;
    case "host-admin":
      return <HostAdminDialog onClose={close} />;
  }
}

function InviteDialog({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const inst = useInstance();
  const api = inst.api;
  const guild = useApp((s) => s.guilds[guildId]);
  const [invite, setInvite] = useState<Invite | null>(null);
  useEffect(() => {
    api<Invite>("POST", `/guilds/${guildId}/invites`).then(setInvite, (e: Error) => {
      toast.error(e.message);
      onClose();
    });
  }, [guildId, onClose]);
  const link = invite ? `${inst.url}/#/invite/${invite.code}` : "";
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

function EditChannelDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const inst = useInstance();
  const api = inst.api;
  const channel = useApp((s) => s.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const canPerms = useChannelCan(channelId, P.MANAGE_ROLES);
  if (!channel) return null;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await api<Channel>("PATCH", `/channels/${channelId}`, {
        name: name.trim(),
        ...(channel.kind === "text" ? { topic: topic.trim() || null } : {}),
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
