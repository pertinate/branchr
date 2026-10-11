import type { PublishLayer } from "@/voice/connection";

export type Resolution = "720" | "1080" | "1440" | "2160" | "source";
export type ContentType = "game" | "desktop";
export type CodecChoice = "auto" | "video/AV1" | "video/VP9" | "video/H264" | "video/H265" | "video/VP8";

export interface StreamSettings {
  resolution: Resolution;
  fps: number;
  /** null = derive from resolution/fps. */
  bitrateMbps: number | null;
  codec: CodecChoice;
  content: ContentType;
  /** Publish extra lower-quality layers so viewers on weak links still get a smooth stream. */
  simulcast: boolean;
  audio: boolean;
}

export const defaultStreamSettings: StreamSettings = {
  resolution: "1080",
  fps: 60,
  bitrateMbps: null,
  codec: "auto",
  content: "game",
  simulcast: true,
  audio: true,
};

export const RESOLUTIONS: { value: Resolution; label: string; height: number | null }[] = [
  { value: "720", label: "720p", height: 720 },
  { value: "1080", label: "1080p", height: 1080 },
  { value: "1440", label: "1440p", height: 1440 },
  { value: "2160", label: "4K", height: 2160 },
  { value: "source", label: "Source", height: null },
];

export const FRAME_RATES = [15, 30, 60, 90, 120, 144, 165, 240];

/** Bits per pixel per frame; motion-heavy game content needs more than static desktop. */
function bpp(content: ContentType) {
  return content === "game" ? 0.085 : 0.05;
}

export function autoBitrateBps(width: number, height: number, fps: number, content: ContentType): number {
  // Bitrate grows sub-linearly with frame rate (inter-frame prediction gets better).
  const effectiveFps = 30 * Math.pow(fps / 30, 0.75);
  return Math.round(width * height * effectiveFps * bpp(content));
}

export function layersFor(s: StreamSettings, width: number, height: number): { layers: PublishLayer[]; maxBitrate: number } {
  const maxBitrate = s.bitrateMbps ? s.bitrateMbps * 1_000_000 : autoBitrateBps(width, height, s.fps, s.content);
  const top: PublishLayer = {
    name: "h",
    encoding: { maxBitrate, maxFramerate: s.fps, priority: "high", networkPriority: "high" },
  };
  if (!s.simulcast) return { layers: [top], maxBitrate };
  return {
    maxBitrate,
    layers: [
      top,
      { name: "m", encoding: { scaleResolutionDownBy: 2, maxBitrate: Math.round(maxBitrate * 0.3), maxFramerate: s.fps, priority: "medium" } },
      {
        name: "l",
        encoding: { scaleResolutionDownBy: 4, maxBitrate: Math.round(maxBitrate * 0.08), maxFramerate: Math.min(s.fps, 30), priority: "low" },
      },
    ],
  };
}

/**
 * Picks the best codec the machine can hardware-encode for WebRTC, falling back to H.264
 * (cheapest software encoder) so high resolution streams don't pin the CPU.
 */
export async function pickCodec(choice: CodecChoice, width: number, height: number, fps: number): Promise<string> {
  const supported = (RTCRtpSender.getCapabilities("video")?.codecs ?? []).map((c) => c.mimeType.toLowerCase());
  if (choice !== "auto" && supported.includes(choice.toLowerCase())) return choice;
  const order = ["video/AV1", "video/H265", "video/VP9", "video/H264"];
  for (const codec of order) {
    if (!supported.includes(codec.toLowerCase())) continue;
    try {
      const info = await navigator.mediaCapabilities.encodingInfo({
        type: "webrtc",
        // VA-API advertises 30 fps maxima but encodes faster in practice; asking for 60 would
        // falsely report software-only.
        video: { contentType: codec, width, height, framerate: Math.min(fps, 30), bitrate: 8_000_000 },
      });
      if (info.supported && info.powerEfficient) return codec;
    } catch {
      /* codec string not understood by this browser */
    }
  }
  return "video/H264";
}

export const cameraEncodings: RTCRtpEncodingParameters[] = [
  { rid: "h", maxBitrate: 2_500_000, maxFramerate: 30 },
  { rid: "m", scaleResolutionDownBy: 2, maxBitrate: 600_000, maxFramerate: 30 },
  { rid: "l", scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
];
