import { Mic as MicIcon, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useVoiceSettings } from "@/stores/voice";
import { type Mic, noiseSuppressionModes, openMic } from "@/voice/mic";

/**
 * Plays your processed microphone back to you (through the chosen output device) with a
 * level meter, so noise suppression modes can be compared by ear. Restarts on any change.
 */
export function MicTest() {
  const s = useVoiceSettings();
  const [on, setOn] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let mic: Mic | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    (async () => {
      try {
        mic = await openMic({
          deviceId: s.inputDeviceId,
          noiseSuppression: s.noiseSuppression,
          echoCancellation: s.echoCancellation,
          autoGainControl: s.autoGainControl,
        });
        if (cancelled) return mic.stop();
        setMode(mic.mode);
        setError(null);
        ctx = new AudioContext({ latencyHint: "interactive" });
        const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
        await sink.setSinkId?.(s.outputDeviceId ?? "").catch(() => {});
        const src = ctx.createMediaStreamSource(new MediaStream([mic.track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        src.connect(ctx.destination);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
          // dBFS mapped onto 0..100% over -60..0 dB.
          const pct = Math.max(0, Math.min(100, ((20 * Math.log10(peak || 1e-6) + 60) / 60) * 100));
          if (bar.current) bar.current.style.width = `${pct}%`;
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      mic?.stop();
      void ctx?.close();
      if (bar.current) bar.current.style.width = "0%";
    };
  }, [on, s.inputDeviceId, s.outputDeviceId, s.noiseSuppression, s.echoCancellation, s.autoGainControl]);

  const label = noiseSuppressionModes.find((m) => m.value === mode)?.label;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-3">
        <Button variant={on ? "secondary" : "default"} size="sm" onClick={() => setOn((v) => !v)}>
          {on ? <Square /> : <MicIcon />}
          {on ? "Stop Testing" : "Mic Test"}
        </Button>
        <div className="h-2 flex-1 overflow-hidden rounded bg-muted" aria-label="Input level">
          <div ref={bar} className="h-full w-0 bg-green-500 transition-[width] duration-75" data-testid="mic-level" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {error
          ? `Microphone unavailable: ${error}`
          : on
            ? `Playing back your mic${label ? ` with ${label}` : ""}. Use headphones to avoid feedback.`
            : "Hear yourself with the current settings. Use headphones."}
      </p>
    </div>
  );
}
