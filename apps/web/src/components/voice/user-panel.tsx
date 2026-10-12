import { Headphones, HeadphoneOff, Mic, MicOff, MonitorUp, PhoneOff, Settings, Signal, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";

import { SettingsDialog } from "@/components/settings-dialog";
import { Menu, SelfMenuItems } from "@/components/menus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { StreamDialog } from "@/components/voice/stream-dialog";
import { hostOf, instance, useInstance } from "@/lib/instances";
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
  // Voice can be on another instance than the one on screen; name it from there.
  const here = useInstance();
  const voiceInst = instance(v.instanceId) ?? here;
  const channel = useStore(voiceInst.app, (s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const guild = useStore(voiceInst.app, (s) => (v.guildId ? s.guilds[v.guildId] : undefined));
  const elsewhere = voiceInst.id !== here.id ? ` · ${hostOf(voiceInst.url)}` : "";
  const root = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const speaking = useVoice((s) => (me ? !!s.speaking[me.id] : false));
  const inVoice = v.status !== "disconnected";
  const expanded = inVoice || hovered || focused || pinned;

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setPinned(false);
        setFocused(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  if (!me) return null;

  return (
    <div
      ref={root}
      className="relative size-12 shrink-0"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          root.current?.querySelector<HTMLButtonElement>("[data-account-trigger]")?.focus();
          setPinned(false);
          setHovered(false);
          setFocused(false);
        }
      }}
    >
      <div
        data-testid="user-panel"
        data-expanded={expanded}
        className={cn(
          "absolute bottom-0 left-0 z-30 overflow-hidden rounded-2xl border border-white/10 bg-[oklch(0.245_0.007_264)] transition-[width,box-shadow] duration-150 motion-reduce:transition-none",
          expanded ? "w-[296px] max-w-[calc(100vw-24px)] shadow-xl" : "w-12",
        )}
      >
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
                  {elsewhere}
                </div>
              </div>
              <IconButton label="Disconnect" onClick={() => { setPinned(false); setFocused(false); v.leave(); }} danger>
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
        <div className="flex h-12 items-center gap-2">
          <Menu items={<SelfMenuItems />}>
            <button
              data-account-trigger
              aria-label="Your account"
              aria-expanded={expanded}
              onClick={() => { setPinned((value) => !value); setFocused(false); }}
              className="grid size-12 shrink-0 place-items-center rounded-2xl hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-3px]"
            >
              <UserAvatar user={me} size={36} status={status} speaking={speaking} />
            </button>
          </Menu>
          {expanded && (
            <>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm font-semibold">{me.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">@{me.username}</div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 pr-2">
                {inVoice && (
                  <>
                    <IconButton label={v.muted ? "Unmute" : "Mute"} onClick={v.toggleMute} danger={v.muted}>
                      {v.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
                    </IconButton>
                    <IconButton label={v.deafened ? "Undeafen" : "Deafen"} onClick={v.toggleDeafen} danger={v.deafened}>
                      {v.deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
                    </IconButton>
                  </>
                )}
                <IconButton label="User Settings" onClick={() => setSettingsOpen(true)}>
                  <Settings className="size-5" />
                </IconButton>
              </div>
            </>
          )}
        </div>
      </div>
      <StreamDialog open={streamOpen} onOpenChange={setStreamOpen} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
