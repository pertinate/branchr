import type { LayerPref, TrackInfo, User } from "@app/protocol";
import { Activity, Eye, Maximize, MicOff, Minimize2, Monitor, Volume2, X } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Menu, UserMenuItems } from "@/components/menus";
import { Button } from "@/components/ui/button";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { UserAvatar, userColor } from "@/components/user-avatar";
import { StatsOverlay, Video, useRtcStats } from "@/components/voice/video";
import { useInstance } from "@/lib/instances";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { mediaUnavailableReason, useVoice, useVoiceSettings } from "@/stores/voice";

type Tile = { kind: "user"; userId: string } | { kind: "stream"; track: TrackInfo } | { kind: "self-stream" };

function tileKey(t: Tile) {
  return t.kind === "user" ? `u-${t.userId}` : t.kind === "stream" ? `s-${t.track.id}` : "self-stream";
}

export function VoiceView({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useApp((s) => s.channels[channelId]);
  const participants = useApp(useShallow((s) => Object.values(s.voice[guildId] ?? {}).filter((v) => v.channelId === channelId).map((v) => v.userId)));
  const instanceId = useInstance().id;
  const connected = useVoice((s) => s.channelId === channelId && s.instanceId === instanceId);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const screens = useVoice(useShallow((s) => Object.values(s.tracks).filter((t) => t.source === "screen")));
  const selfStream = useVoice((s) => !!s.screen);
  const [focus, setFocus] = useState<string | null>(null);

  const tiles: Tile[] = useMemo(
    () => [
      ...screens.map((track) => ({ kind: "stream" as const, track })),
      ...(selfStream ? [{ kind: "self-stream" as const }] : []),
      ...participants.map((userId) => ({ kind: "user" as const, userId })),
    ],
    [screens, selfStream, participants],
  );
  const focused = tiles.find((t) => tileKey(t) === focus);

  if (!connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-black/30">
        <h2 className="text-2xl font-bold">{channel?.name}</h2>
        <p className="text-muted-foreground">{participants.length ? `${participants.length} in voice` : "No one is here yet."}</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {mediaUnavailableReason() && <p className="max-w-sm text-center text-sm text-idle">{mediaUnavailableReason()} You can still listen.</p>}
        <Button size="lg" disabled={status === "connecting"} onClick={() => void useVoice.getState().join(guildId, channelId, instanceId)}>
          {status === "connecting" ? "Connecting…" : "Join Voice"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-black">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Volume2 className="size-5 text-muted-foreground" />
        <span className="font-semibold">{channel?.name}</span>
      </header>
      {focused ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="min-h-0 flex-1">
            <TileView tile={focused} guildId={guildId} focused onFocus={() => setFocus(null)} />
          </div>
          <div className="flex h-28 shrink-0 justify-center gap-2 overflow-x-auto">
            {tiles
              .filter((t) => tileKey(t) !== focus)
              .map((t) => (
                <div key={tileKey(t)} className="aspect-video h-full">
                  <TileView tile={t} guildId={guildId} onFocus={() => setFocus(tileKey(t))} small />
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-fr gap-2 overflow-y-auto p-2" style={{ gridTemplateColumns: `repeat(${Math.min(Math.ceil(Math.sqrt(tiles.length)), 4)}, minmax(0, 1fr))` }}>
          {tiles.map((t) => (
            <TileView key={tileKey(t)} tile={t} guildId={guildId} onFocus={() => setFocus(tileKey(t))} />
          ))}
        </div>
      )}
    </div>
  );
}

function TileView({ tile, guildId, focused, small, onFocus }: { tile: Tile; guildId: string; focused?: boolean; small?: boolean; onFocus: () => void }) {
  if (tile.kind === "user") return <UserTile userId={tile.userId} guildId={guildId} small={small} onFocus={onFocus} />;
  if (tile.kind === "self-stream") return <SelfStreamTile focused={focused} small={small} onFocus={onFocus} />;
  return <StreamTile track={tile.track} guildId={guildId} focused={focused} small={small} onFocus={onFocus} />;
}

const UserTile = memo(function UserTile({ userId, guildId, small, onFocus }: { userId: string; guildId: string; small?: boolean; onFocus: () => void }) {
  const member = useApp((s) => s.members[guildId]?.[userId]);
  const vs = useApp((s) => s.voice[guildId]?.[userId]);
  const speaking = useVoice((s) => !!s.speaking[userId]);
  const meId = useApp((s) => s.me?.id);
  const localCamera = useVoice((s) => (userId === meId ? s.camera : null));
  const camera = useVoice((s) => {
    const t = Object.values(s.tracks).find((t) => t.userId === userId && t.source === "camera");
    return t ? s.subs[t.id]?.track : undefined;
  });
  if (!member) return null;
  const hasVideo = !!localCamera || !!camera;
  return (
    <Menu items={<UserMenuItems guildId={guildId} userId={userId} />}>
    <div
      onDoubleClick={onFocus}
      className={cn("relative grid size-full min-h-32 place-items-center overflow-hidden rounded-lg transition-shadow", speaking && "ring-2 ring-online")}
      style={{ background: hasVideo ? "black" : userColor(userId) + "55" }}
    >
      {localCamera ? <Video stream={localCamera} mirror contain={false} /> : camera ? <Video track={camera} contain={false} /> : <UserAvatar user={member.user} size={small ? 40 : 80} />}
      <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/60 px-2 py-0.5 text-sm">
        {vs?.selfMute && <MicOff className="size-3.5 text-destructive" />}
        {member.nick ?? member.user.displayName}
      </div>
      {!small && userId !== meId && <VolumeControl user={member.user} />}
    </div>
    </Menu>
  );
});

function VolumeControl({ user }: { user: User }) {
  const vol = useVoiceSettings((s) => s.userVolumes[user.id] ?? 1);
  return (
    <div className="absolute top-2 right-2 flex w-32 items-center gap-2 rounded bg-black/60 px-2 py-1 opacity-0 transition-opacity [div:hover>&]:opacity-100">
      <Volume2 className="size-3.5 shrink-0" />
      <Slider
        min={0}
        max={200}
        step={5}
        value={[Math.round(vol * 100)]}
        onValueChange={([v]) => useVoiceSettings.getState().setSettings({ userVolumes: { ...useVoiceSettings.getState().userVolumes, [user.id]: v / 100 } })}
      />
    </div>
  );
}

function useFullscreen() {
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen();
  };
  return { ref, toggle };
}

const LAYERS: { value: LayerPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "high", label: "Source" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function StreamTile({ track, guildId, focused, small, onFocus }: { track: TrackInfo; guildId: string; focused?: boolean; small?: boolean; onFocus: () => void }) {
  const member = useApp((s) => s.members[guildId]?.[track.userId]);
  const sub = useVoice((s) => s.subs[track.id]);
  const watching = useVoice((s) => s.watching.includes(track.id));
  const estimate = useVoice((s) => s.estimateBps);
  const [showStats, setShowStats] = useState(false);
  const receiver = useMemo(() => (sub ? (useVoice.getState().connection()?.receiver(track.id) ?? null) : null), [sub, track.id]);
  const stats = useRtcStats(receiver, showStats);
  const fs = useFullscreen();
  const name = member?.nick ?? member?.user.displayName ?? "Someone";

  if (!watching || !sub) {
    return (
      <div className="relative grid size-full min-h-32 place-items-center rounded-lg bg-[oklch(0.25_0.01_264)]">
        <div className="flex flex-col items-center gap-2">
          {!small && <Monitor className="size-8 text-muted-foreground" />}
          <span className={cn("text-center", small ? "text-xs" : "text-sm")}>{name} is live</span>
          <Button size={small ? "xs" : "sm"} onClick={() => void useVoice.getState().watch(track.id).then(() => !small && onFocus())}>
            <Eye /> Watch Stream
          </Button>
        </div>
        <span className="absolute top-2 left-2 rounded bg-live px-1.5 text-xs font-bold text-white">LIVE</span>
      </div>
    );
  }

  const streamItems = (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Quality</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup value={sub.pref} onValueChange={(v) => useVoice.getState().setLayer(track.id, v as LayerPref)}>
            {LAYERS.map((l) => (
              <ContextMenuRadioItem key={l.value} value={l.value} disabled={l.value !== "auto" && track.layers.length === 0}>
                {l.label}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuCheckboxItem checked={showStats} onCheckedChange={(v) => setShowStats(!!v)}>
        Stream Stats
      </ContextMenuCheckboxItem>
      <ContextMenuItem onSelect={onFocus}>{focused ? "Unfocus" : "Focus"}</ContextMenuItem>
      <ContextMenuItem onSelect={fs.toggle}>Fullscreen</ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => useVoice.getState().unwatch(track.id)}>
        Stop Watching
      </ContextMenuItem>
      <ContextMenuSeparator />
      <UserMenuItems guildId={guildId} userId={track.userId} />
    </>
  );

  return (
    <Menu items={streamItems}>
    <div ref={fs.ref} className="group relative size-full min-h-32 overflow-hidden rounded-lg bg-black" onDoubleClick={fs.toggle} onClick={small ? onFocus : undefined}>
      <Video track={sub.track} />
      {showStats && <StatsOverlay stats={stats} layer={sub.layer} estimateBps={estimate} />}
      <span className="absolute top-2 right-2 rounded bg-live px-1.5 text-xs font-bold text-white">LIVE</span>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="flex-1 truncate text-sm font-medium">{name}</span>
        {!small && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="secondary">Quality: {LAYERS.find((l) => l.value === sub.pref)?.label}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup value={sub.pref} onValueChange={(v) => useVoice.getState().setLayer(track.id, v as LayerPref)}>
                  {LAYERS.map((l) => (
                    <DropdownMenuRadioItem key={l.value} value={l.value} disabled={l.value !== "auto" && track.layers.length === 0}>
                      {l.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="icon-xs" variant="secondary" title="Stream stats" onClick={() => setShowStats((v) => !v)}>
              <Activity />
            </Button>
            <Button size="icon-xs" variant="secondary" title={focused ? "Unfocus" : "Focus"} onClick={onFocus}>
              <Minimize2 />
            </Button>
            <Button size="icon-xs" variant="secondary" title="Fullscreen" onClick={fs.toggle}>
              <Maximize />
            </Button>
          </>
        )}
        <Button size="icon-xs" variant="destructive" title="Stop watching" onClick={(e) => { e.stopPropagation(); useVoice.getState().unwatch(track.id); }}>
          <X />
        </Button>
      </div>
    </div>
    </Menu>
  );
}

function SelfStreamTile({ focused, small, onFocus }: { focused?: boolean; small?: boolean; onFocus: () => void }) {
  const screen = useVoice((s) => s.screen);
  const sender = useVoice((s) => s.screenSender);
  const [showStats, setShowStats] = useState(false);
  const [preview, setPreview] = useState(true);
  const stats = useRtcStats(sender, showStats);
  return (
    <div className="group relative grid size-full min-h-32 place-items-center overflow-hidden rounded-lg bg-black" onClick={small ? onFocus : undefined}>
      {/* Hiding the local preview saves a full-resolution decode/compose on the streamer's machine. */}
      {preview ? <Video stream={screen} /> : <span className="text-sm text-muted-foreground">Preview hidden</span>}
      {showStats && <StatsOverlay stats={stats} />}
      <span className="absolute top-2 left-2 rounded bg-live px-1.5 text-xs font-bold text-white">YOUR STREAM</span>
      {!small && (
        <div className="absolute right-2 bottom-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button size="xs" variant="secondary" onClick={() => setPreview((p) => !p)}>{preview ? "Hide preview" : "Show preview"}</Button>
          <Button size="icon-xs" variant="secondary" title="Encoder stats" onClick={() => setShowStats((v) => !v)}>
            <Activity />
          </Button>
          <Button size="icon-xs" variant="secondary" title={focused ? "Unfocus" : "Focus"} onClick={onFocus}>
            <Minimize2 />
          </Button>
          <Button size="xs" variant="destructive" onClick={() => void useVoice.getState().stopStream()}>Stop</Button>
        </div>
      )}
    </div>
  );
}
