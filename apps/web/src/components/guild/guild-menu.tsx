import { useNavigate } from "@tanstack/react-router";
import { Bell, ChevronDown, LogOut, Pencil, PlusCircle, Settings, Smile, Trash2, UserPlus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { leaveGuild } from "@/lib/actions";
import { useInstance } from "@/lib/instances";
import { type NotifyLevel, notifyLevel, useGuildMuted, useMutes } from "@/lib/mutes";
import { P, SETTINGS_PERMS, useCan, useCanAny } from "@/lib/perms";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/ui";

export function GuildMenu({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const instanceId = inst.id;
  const guild = useApp((s) => s.guilds[guildId]);
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  const canInvite = useCan(guildId, P.CREATE_INVITE);
  const canSettings = useCanAny(guildId, SETTINGS_PERMS);
  const canChannels = useCan(guildId, P.MANAGE_CHANNELS);
  const navigate = useNavigate();
  const open = useDialogs((s) => s.open);
  const muted = useGuildMuted(instanceId, guildId);
  const level = useMutes((m) => notifyLevel(m, instanceId, guildId));

  if (!guild) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-12 shrink-0 items-center justify-between border-b border-black/20 px-4 font-semibold shadow-sm hover:bg-sidebar-accent/60">
          <span className="truncate">{guild.name}</span>
          <ChevronDown className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        {canInvite && (
          <DropdownMenuItem onClick={() => open({ instanceId, kind: "invite", guildId })} className="text-primary">
            Invite People <UserPlus className="ml-auto" />
          </DropdownMenuItem>
        )}
        {canSettings && (
          <DropdownMenuItem onClick={() => open({ instanceId, kind: "guild-settings", guildId, tab: "overview" })}>
            Community Settings <Settings className="ml-auto" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => open({ instanceId, kind: "guild-settings", guildId, tab: "emotes" })}>
          Emotes <Smile className="ml-auto" />
        </DropdownMenuItem>
        {canChannels && (
          <DropdownMenuItem onClick={() => open({ instanceId, kind: "create-channel", guildId, parentId: null })}>
            Create Channel <PlusCircle className="ml-auto" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => open({ instanceId, kind: "nickname", guildId })}>
          Change Nickname <Pencil className="ml-auto" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={muted} onCheckedChange={(on) => useMutes.getState().muteGuild(instanceId, guildId, on)}>
          Mute Community
        </DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            Notification Settings <Bell className="ml-auto size-4" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            <DropdownMenuRadioGroup value={level} onValueChange={(v) => useMutes.getState().setLevel(instanceId, guildId, v as NotifyLevel)}>
              <DropdownMenuRadioItem value="all">All Messages</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="mentions">Only @mentions</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="nothing">Nothing</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void leaveGuild(inst, guildId).then((left) => { if (left) void navigate({ to: "/" }); })}>
          {isOwner ? "Delete Community" : "Leave Community"} {isOwner ? <Trash2 className="ml-auto" /> : <LogOut className="ml-auto" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
