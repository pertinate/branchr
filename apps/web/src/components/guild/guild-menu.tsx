import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, LogOut, Pencil, PlusCircle, Settings, Smile, Trash2, UserPlus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { leaveGuild } from "@/lib/actions";
import { useInstance } from "@/lib/instances";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/ui";

export function GuildMenu({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const instanceId = inst.id;
  const guild = useApp((s) => s.guilds[guildId]);
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  const navigate = useNavigate();
  const open = useDialogs((s) => s.open);

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
        <DropdownMenuItem onClick={() => open({ instanceId, kind: "invite", guildId })} className="text-primary">
          Invite People <UserPlus className="ml-auto" />
        </DropdownMenuItem>
        {isOwner && (
          <DropdownMenuItem onClick={() => open({ instanceId, kind: "guild-settings", guildId, tab: "overview" })}>
            Server Settings <Settings className="ml-auto" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => open({ instanceId, kind: "guild-settings", guildId, tab: "emotes" })}>
          Emotes <Smile className="ml-auto" />
        </DropdownMenuItem>
        {isOwner && (
          <DropdownMenuItem onClick={() => open({ instanceId, kind: "create-channel", guildId, parentId: null })}>
            Create Channel <PlusCircle className="ml-auto" />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => open({ instanceId, kind: "nickname", guildId })}>
          Change Nickname <Pencil className="ml-auto" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void leaveGuild(inst, guildId).then((left) => { if (left) void navigate({ to: "/" }); })}>
          {isOwner ? "Delete Server" : "Leave Server"} {isOwner ? <Trash2 className="ml-auto" /> : <LogOut className="ml-auto" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
