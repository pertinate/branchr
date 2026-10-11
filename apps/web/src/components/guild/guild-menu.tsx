import type { Invite } from "@app/protocol";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Copy, LogOut, PlusCircle, Settings, Smile, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { GuildSettingsDialog } from "@/components/guild/guild-settings-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useAuth } from "@/stores/auth";

export function GuildMenu({ guildId, onCreateChannel }: { guildId: string; onCreateChannel: () => void }) {
  const guild = useApp((s) => s.guilds[guildId]);
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  const navigate = useNavigate();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [settings, setSettings] = useState<"overview" | "emotes" | null>(null);

  const createInvite = async () => {
    try {
      setInvite(await api<Invite>("POST", `/guilds/${guildId}/invites`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const leave = async () => {
    const verb = isOwner ? "Delete" : "Leave";
    if (!confirm(`${verb} "${guild?.name}"?`)) return;
    try {
      await api("DELETE", isOwner ? `/guilds/${guildId}` : `/guilds/${guildId}/members/@me`);
      useApp.getState().apply({ t: "GUILD_DELETE", d: { id: guildId } });
      void navigate({ to: "/" });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!guild) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-12 shrink-0 items-center justify-between border-b border-black/20 px-4 font-semibold shadow-sm hover:bg-sidebar-accent/60">
            <span className="truncate">{guild.name}</span>
            <ChevronDown className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem onClick={createInvite} className="text-primary">
            Invite People <UserPlus className="ml-auto" />
          </DropdownMenuItem>
          {isOwner && (
            <DropdownMenuItem onClick={() => setSettings("overview")}>
              Server Settings <Settings className="ml-auto" />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setSettings("emotes")}>
            Emotes <Smile className="ml-auto" />
          </DropdownMenuItem>
          {isOwner && (
            <DropdownMenuItem onClick={onCreateChannel}>
              Create Channel <PlusCircle className="ml-auto" />
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={leave}>
            {isOwner ? "Delete Server" : "Leave Server"} {isOwner ? <Trash2 className="ml-auto" /> : <LogOut className="ml-auto" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!invite} onOpenChange={(o) => !o && setInvite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite friends to {guild.name}</DialogTitle>
            <DialogDescription>
              Friends paste this in "Add a Server → Join". Invites only work on this server, so the link includes it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={invite?.code ?? ""} className="font-mono" aria-label="Invite code" />
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(`${useAuth.getState().serverUrl}/#/invite/${invite?.code ?? ""}`);
                toast.success("Copied invite link");
              }}
            >
              <Copy /> Copy link
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {settings && <GuildSettingsDialog guildId={guildId} tab={settings} onClose={() => setSettings(null)} />}
    </>
  );
}
