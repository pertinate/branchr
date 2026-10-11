import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Settings, Signal, Video, VideoOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { SettingsDialog } from "@/components/settings-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Menu, SelfMenuItems } from "@/components/menus";
import { UserAvatar } from "@/components/user-avatar";
import { StreamDialog } from "@/components/voice/stream-dialog";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useVoice } from "@/stores/voice";

function IconButton({ label, onClick, active, danger, children }: { label: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={label}
          className={cn(
            "grid size-8 place-items-center rounded-md hover:bg-sidebar-accent",
            danger ? "text-destructive" : active ? "text-foreground" : "text-sidebar-foreground hover:text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function UserPanel() {
  const me = useApp((s) => s.me);
  const status = useApp((s) => (s.me ? (s.presences[s.me.id] ?? "online") : "offline"));
  const v = useVoice();
  const channel = useApp((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const guild = useApp((s) => (v.guildId ? s.guilds[v.guildId] : undefined));
  const [streamOpen, setStreamOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const speaking = useVoice((s) => (me ? !!s.speaking[me.id] : false));
  if (!me) return null;
  const inVoice = v.status !== "disconnected";

  return (
    <div className="bg-[oklch(0.245_0.007_264)]">
      {inVoice && (
        <div className="border-b border-white/5 px-2 py-2">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <div className={cn("flex items-center gap-1 text-sm font-semibold", v.status === "connected" ? "text-online" : "text-idle")}>
                <Signal className="size-4" />
                {v.status === "connected" ? "Voice Connected" : v.status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {channel?.name} / {guild?.name}
              </div>
            </div>
            <IconButton label="Disconnect" onClick={() => v.leave()} danger>
              <PhoneOff className="size-5" />
            </IconButton>
          </div>
          {v.status === "connected" && (
            <div className="mt-2 grid grid-cols-2 gap-1">
              <button
                onClick={() => v.toggleCamera().catch((e) => toast.error(`Camera: ${(e as Error).message}`))}
                className={cn("flex items-center justify-center gap-1 rounded-md py-1.5 text-sm", v.camera ? "bg-primary text-white" : "bg-sidebar-accent hover:bg-accent")}
              >
                {v.camera ? <Video className="size-4" /> : <VideoOff className="size-4" />} Video
              </button>
              <button
                onClick={() => (v.screen ? void v.stopStream() : setStreamOpen(true))}
                className={cn("flex items-center justify-center gap-1 rounded-md py-1.5 text-sm", v.screen ? "bg-live text-white" : "bg-sidebar-accent hover:bg-accent")}
              >
                <MonitorUp className="size-4" /> {v.screen ? "Stop" : "Stream"}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Menu items={<SelfMenuItems />}>
          <span className="block cursor-pointer" aria-label="Your account">
            <UserAvatar user={me} size={32} status={status} speaking={speaking} />
          </span>
        </Menu>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-semibold">{me.displayName}</div>
          <div className="truncate text-xs text-muted-foreground">@{me.username}</div>
        </div>
        <IconButton label={v.muted ? "Unmute" : "Mute"} onClick={v.toggleMute} danger={v.muted}>
          {v.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </IconButton>
        <IconButton label={v.deafened ? "Undeafen" : "Deafen"} onClick={v.toggleDeafen} danger={v.deafened}>
          {v.deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
        </IconButton>
        <IconButton label="User Settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="size-5" />
        </IconButton>
      </div>
      <StreamDialog open={streamOpen} onOpenChange={setStreamOpen} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
