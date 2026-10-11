/**
 * Right-click menus for servers, channels and people. Messages have their own (in
 * message-item.tsx) because they need the message's local state.
 */
import type { ReactNode } from "react";
import type { Status } from "@app/protocol";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AtSign, CheckCheck, Copy, LogOut, Pencil, PhoneOff, PlusCircle, Settings, Smile, Trash2, UserMinus, UserPlus, Volume2 } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Slider } from "@/components/ui/slider";
import { copy, deleteChannel, insertIntoComposer, kick, leaveGuild, markGuildRead, setStatus } from "@/lib/actions";
import { useInstance } from "@/lib/instances";
import { useApp } from "@/stores/app";
import { useDialogs, usePrefs } from "@/stores/ui";
import { useVoice, useVoiceSettings } from "@/stores/voice";

/** Right-click `children` for `items`. `children` must take a ref (a DOM element or forwardRef). */
export function Menu({ items, children }: { items: ReactNode; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">{items}</ContextMenuContent>
    </ContextMenu>
  );
}

function CopyId({ id, label }: { id: string; label: string }) {
  const devMode = usePrefs((s) => s.devMode);
  if (!devMode) return null;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void copy(id, `Copied ${label.toLowerCase()}`)}>
        Copy {label} <Copy className="ml-auto" />
      </ContextMenuItem>
    </>
  );
}

export function GuildMenuItems({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const instanceId = inst.id;
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  const open = useDialogs((s) => s.open);
  const navigate = useNavigate();
  return (
    <>
      <ContextMenuItem onSelect={() => markGuildRead(inst, guildId)}>
        Mark As Read <CheckCheck className="ml-auto" />
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem className="text-primary" onSelect={() => open({ instanceId, kind: "invite", guildId })}>
        Invite People <UserPlus className="ml-auto" />
      </ContextMenuItem>
      {isOwner && (
        <ContextMenuItem onSelect={() => open({ instanceId, kind: "guild-settings", guildId, tab: "overview" })}>
          Server Settings <Settings className="ml-auto" />
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => open({ instanceId, kind: "guild-settings", guildId, tab: "emotes" })}>
        Emotes <Smile className="ml-auto" />
      </ContextMenuItem>
      {isOwner && (
        <ContextMenuItem onSelect={() => open({ instanceId, kind: "create-channel", guildId, parentId: null })}>
          Create Channel <PlusCircle className="ml-auto" />
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => open({ instanceId, kind: "nickname", guildId })}>
        Change Nickname <Pencil className="ml-auto" />
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => void leaveGuild(inst, guildId).then((left) => { if (left) void navigate({ to: "/" }); })}
      >
        {isOwner ? "Delete Server" : "Leave Server"} {isOwner ? <Trash2 className="ml-auto" /> : <LogOut className="ml-auto" />}
      </ContextMenuItem>
      <CopyId id={guildId} label="Server ID" />
    </>
  );
}

export function ChannelMenuItems({ channelId }: { channelId: string }) {
  const inst = useInstance();
  const instanceId = inst.id;
  const channel = useApp((s) => s.channels[channelId]);
  const isOwner = useApp((s) => !!channel && s.guilds[channel.guildId]?.ownerId === s.me?.id);
  const inThis = useVoice((s) => s.channelId === channelId && s.instanceId === instanceId);
  const open = useDialogs((s) => s.open);
  if (!channel) return null;
  const what = channel.kind === "category" ? "Category" : "Channel";
  return (
    <>
      {channel.kind === "text" && (
        <ContextMenuItem onSelect={() => inst.app.getState().markRead(channelId)}>
          Mark As Read <CheckCheck className="ml-auto" />
        </ContextMenuItem>
      )}
      {channel.kind === "voice" &&
        (inThis ? (
          <ContextMenuItem onSelect={() => useVoice.getState().leave()}>
            Disconnect <PhoneOff className="ml-auto" />
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => void useVoice.getState().join(channel.guildId, channelId, instanceId)}>
            Join Voice <Volume2 className="ml-auto" />
          </ContextMenuItem>
        ))}
      {channel.kind === "category" && isOwner && (
        <ContextMenuItem onSelect={() => open({ instanceId, kind: "create-channel", guildId: channel.guildId, parentId: channelId })}>
          Create Channel <PlusCircle className="ml-auto" />
        </ContextMenuItem>
      )}
      {isOwner && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => open({ instanceId, kind: "edit-channel", channelId })}>
            Edit {what} <Pencil className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => void deleteChannel(inst, channelId)}>
            Delete {what} <Trash2 className="ml-auto" />
          </ContextMenuItem>
        </>
      )}
      <CopyId id={channelId} label={`${what} ID`} />
    </>
  );
}

export function UserMenuItems({ guildId, userId }: { guildId: string; userId: string }) {
  const inst = useInstance();
  const instanceId = inst.id;
  const member = useApp((s) => s.members[guildId]?.[userId]);
  const me = useApp((s) => s.me?.id);
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === me);
  const ownerId = useApp((s) => s.guilds[guildId]?.ownerId);
  const viewing = useApp((s) => s.viewing);
  // Volume applies to people in our voice channel.
  const myVoice = useVoice((s) => (s.instanceId === instanceId ? s.channelId : null));
  const together = useApp((s) => !!myVoice && s.voice[guildId]?.[userId]?.channelId === myVoice);
  const volume = useVoiceSettings((s) => s.userVolumes[userId] ?? 1);
  const open = useDialogs((s) => s.open);
  if (!member) return null;
  const self = userId === me;
  return (
    <>
      <ContextMenuLabel className="truncate">{member.nick ?? member.user.displayName}</ContextMenuLabel>
      {viewing && (
        <ContextMenuItem onSelect={() => insertIntoComposer(`@${member.user.username} `)}>
          Mention <AtSign className="ml-auto" />
        </ContextMenuItem>
      )}
      {self && (
        <ContextMenuItem onSelect={() => open({ instanceId, kind: "nickname", guildId })}>
          Change Nickname <Pencil className="ml-auto" />
        </ContextMenuItem>
      )}
      {together && !self && (
        <div className="px-1.5 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <div className="mb-2 flex justify-between text-xs text-muted-foreground">
            <span>User Volume</span>
            <span>{Math.round(volume * 100)}%</span>
          </div>
          <Slider
            aria-label="User volume"
            min={0}
            max={200}
            step={5}
            value={[Math.round(volume * 100)]}
            onValueChange={([v]) => useVoiceSettings.getState().setSettings({ userVolumes: { ...useVoiceSettings.getState().userVolumes, [userId]: v / 100 } })}
          />
        </div>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void copy(member.user.username, "Copied username")}>
        Copy Username <Copy className="ml-auto" />
      </ContextMenuItem>
      {isOwner && !self && userId !== ownerId && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void kick(inst, guildId, userId)}>
            Kick {member.nick ?? member.user.displayName} <UserMinus className="ml-auto" />
          </ContextMenuItem>
        </>
      )}
      <CopyId id={userId} label="User ID" />
    </>
  );
}

/** Your own avatar in the user panel. */
export function SelfMenuItems() {
  const instanceId = useInstance().id;
  const me = useApp((s) => s.me);
  const status = useApp((s) => (s.me ? (s.presences[s.me.id] ?? "online") : "online"));
  const { guildId } = useParams({ strict: false }) as { guildId?: string };
  const open = useDialogs((s) => s.open);
  if (!me) return null;
  return (
    <>
      <ContextMenuLabel className="truncate">{me.displayName}</ContextMenuLabel>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Status</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup value={status} onValueChange={(v) => setStatus(v as Status)}>
            <ContextMenuRadioItem value="online">Online</ContextMenuRadioItem>
            <ContextMenuRadioItem value="idle">Idle</ContextMenuRadioItem>
            <ContextMenuRadioItem value="dnd">Do Not Disturb</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      {guildId && (
        <ContextMenuItem onSelect={() => open({ instanceId, kind: "nickname", guildId })}>
          Change Nickname <Pencil className="ml-auto" />
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void copy(me.username, "Copied username")}>
        Copy Username <Copy className="ml-auto" />
      </ContextMenuItem>
      <CopyId id={me.id} label="User ID" />
    </>
  );
}
