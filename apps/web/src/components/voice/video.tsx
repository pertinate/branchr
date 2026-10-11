import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export function Video({ track, stream, className, mirror, contain = true }: { track?: MediaStreamTrack; stream?: MediaStream | null; className?: string; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream ?? (track ? new MediaStream([track]) : null);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [track, stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      disablePictureInPicture
      className={cn("size-full bg-black", contain ? "object-contain" : "object-cover", mirror && "-scale-x-100", className)}
    />
  );
}

interface Stats {
  width?: number;
  height?: number;
  fps?: number;
  kbps?: number;
  codec?: string;
  impl?: string;
  hw?: boolean;
  delayMs?: number;
  lost?: number;
  limitation?: string;
  layers?: string;
}

/** Polls WebRTC stats for a receiver (viewer) or sender (streamer). */
export function useRtcStats(target: RTCRtpReceiver | RTCRtpSender | null | undefined, enabled: boolean) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    if (!target || !enabled) return;
    let prev: { bytes: number; ts: number } | null = null;
    const tick = async () => {
      const report = await target.getStats();
      const codecs = new Map<string, string>();
      const s: Stats = {};
      let bytes = 0;
      let ts = 0;
      const layers: string[] = [];
      report.forEach((r) => {
        if (r.type === "codec") codecs.set(r.id, (r.mimeType as string).replace("video/", ""));
      });
      report.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          Object.assign(s, {
            width: r.frameWidth,
            height: r.frameHeight,
            fps: r.framesPerSecond,
            codec: codecs.get(r.codecId),
            impl: r.decoderImplementation,
            hw: r.powerEfficientDecoder,
            lost: r.packetsLost,
            delayMs: r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : undefined,
          });
          bytes += r.bytesReceived;
          ts = r.timestamp;
        }
        if (r.type === "outbound-rtp" && r.kind === "video") {
          bytes += r.bytesSent;
          ts = r.timestamp;
          if (r.frameWidth) layers.push(`${r.rid ?? "-"}:${r.frameHeight}p${Math.round(r.framesPerSecond ?? 0)}`);
          // Report the top layer's numbers.
          if (!s.width || (r.frameWidth ?? 0) > s.width) {
            Object.assign(s, {
              width: r.frameWidth,
              height: r.frameHeight,
              fps: r.framesPerSecond,
              codec: codecs.get(r.codecId),
              impl: r.encoderImplementation,
              hw: r.powerEfficientEncoder,
              limitation: r.qualityLimitationReason,
            });
          }
        }
      });
      if (layers.length > 1) s.layers = layers.join(" ");
      if (prev && ts > prev.ts) s.kbps = Math.round(((bytes - prev.bytes) * 8) / (ts - prev.ts));
      prev = { bytes, ts };
      setStats(s);
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [target, enabled]);
  return stats;
}

export function StatsOverlay({ stats, layer, estimateBps }: { stats: Stats | null; layer?: string | null; estimateBps?: number }) {
  if (!stats) return null;
  const rows: [string, string | undefined][] = [
    ["Resolution", stats.width ? `${stats.width}×${stats.height}` : undefined],
    ["FPS", stats.fps?.toFixed(0)],
    ["Bitrate", stats.kbps !== undefined ? (stats.kbps >= 1000 ? `${(stats.kbps / 1000).toFixed(1)} Mbps` : `${stats.kbps} kbps`) : undefined],
    ["Codec", stats.codec],
    ["Pipeline", stats.impl ? `${stats.impl}${stats.hw ? " (HW)" : stats.hw === false ? " (SW)" : ""}` : undefined],
    ["Jitter buffer", stats.delayMs !== undefined ? `${stats.delayMs} ms` : undefined],
    ["Packets lost", stats.lost?.toString()],
    ["Limited by", stats.limitation && stats.limitation !== "none" ? stats.limitation : undefined],
    ["Layers", stats.layers],
    ["Layer", layer ?? undefined],
    ["Downlink est.", estimateBps ? `${(estimateBps / 1e6).toFixed(1)} Mbps` : undefined],
  ];
  return (
    <div className="pointer-events-none absolute top-2 left-2 rounded bg-black/70 px-2 py-1 font-mono text-[11px] leading-4 text-white">
      {rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => (
          <div key={k}>
            <span className="text-white/60">{k}:</span> {v}
          </div>
        ))}
    </div>
  );
}
