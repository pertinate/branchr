import { Gamepad2, Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type DesktopSource, desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { useVoice, useVoiceSettings } from "@/stores/voice";
import { type CodecChoice, FRAME_RATES, RESOLUTIONS, type StreamSettings, autoBitrateBps } from "@/voice/presets";

const CODECS: { value: CodecChoice; label: string }[] = [
  { value: "auto", label: "Auto (prefer hardware)" },
  { value: "video/AV1", label: "AV1" },
  { value: "video/H265", label: "H.265 / HEVC" },
  { value: "video/VP9", label: "VP9" },
  { value: "video/H264", label: "H.264" },
  { value: "video/VP8", label: "VP8" },
];

export function StreamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const saved = useVoiceSettings((s) => s.stream);
  const [s, setS] = useState<StreamSettings>(saved);
  const [sources, setSources] = useState<DesktopSource[] | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<StreamSettings>) => setS((x) => ({ ...x, ...p }));

  // On X11 the app shows its own picker; on Wayland the system portal does.
  useEffect(() => {
    if (!open || !desktop || desktop.systemPicker) return;
    void desktop.getSources().then((src) => {
      setSources(src);
      setSourceId((cur) => cur ?? src[0]?.id ?? null);
    });
  }, [open]);

  const height = RESOLUTIONS.find((r) => r.value === s.resolution)?.height ?? 1440;
  const autoMbps = autoBitrateBps(Math.round((height * 16) / 9), height, s.fps, s.content) / 1e6;

  const go = async () => {
    setBusy(true);
    try {
      if (desktop && !desktop.systemPicker) await desktop.selectSource(sourceId);
      await useVoice.getState().startStream(s);
      onOpenChange(false);
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") toast.error(`Couldn't start stream: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Go Live</DialogTitle>
          <DialogDescription>No caps: stream at your source resolution and refresh rate. Viewers on slower connections automatically get a lower layer.</DialogDescription>
        </DialogHeader>

        {sources && (
          <div className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto">
            {sources.map((src) => (
              <button
                key={src.id}
                onClick={() => setSourceId(src.id)}
                className={cn("rounded-md border-2 p-1 text-left text-xs", sourceId === src.id ? "border-primary" : "border-transparent hover:border-border")}
              >
                <img src={src.thumbnail} alt="" className="aspect-video w-full rounded bg-black object-contain" />
                <div className="mt-1 truncate">{src.name}</div>
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {(["game", "desktop"] as const).map((c) => (
            <button
              key={c}
              onClick={() => set({ content: c })}
              className={cn("flex items-center gap-2 rounded-md border p-3 text-left", s.content === c ? "border-primary bg-accent" : "border-border hover:bg-accent/50")}
            >
              {c === "game" ? <Gamepad2 /> : <Monitor />}
              <div>
                <div className="text-sm font-medium">{c === "game" ? "Game" : "Desktop / Text"}</div>
                <div className="text-xs text-muted-foreground">{c === "game" ? "Prioritize smooth motion" : "Prioritize sharp detail"}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <Label>Resolution</Label>
          <div className="flex flex-wrap gap-1.5">
            {RESOLUTIONS.map((r) => (
              <Button key={r.value} size="sm" variant={s.resolution === r.value ? "default" : "secondary"} onClick={() => set({ resolution: r.value })}>
                {r.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label>Frame rate</Label>
          <div className="flex flex-wrap gap-1.5">
            {FRAME_RATES.map((f) => (
              <Button key={f} size="sm" variant={s.fps === f ? "default" : "secondary"} onClick={() => set({ fps: f })}>
                {f}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Max bitrate (Mbps)</Label>
            <Input
              type="number"
              min={0.5}
              max={200}
              step={0.5}
              placeholder={`Auto (~${autoMbps.toFixed(1)})`}
              value={s.bitrateMbps ?? ""}
              onChange={(e) => set({ bitrateMbps: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
          <div className="space-y-2">
            <Label>Codec</Label>
            <Select value={s.codec} onValueChange={(v) => set({ codec: v as CodecChoice })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODECS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Adaptive layers (simulcast)</div>
              <div className="text-xs text-muted-foreground">Also encodes ½ and ¼ resolution so every viewer gets a smooth stream. Uses more encoder time.</div>
            </div>
            <Switch checked={s.simulcast} onCheckedChange={(v) => set({ simulcast: v })} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <div className="text-sm font-medium">Stream audio</div>
            <Switch checked={s.audio} onCheckedChange={(v) => set({ audio: v })} />
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={go} disabled={busy || (!!sources && !sourceId)} className="bg-live text-white hover:bg-live/90">Go Live</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
