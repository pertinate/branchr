/**
 * Microphone capture with optional neural noise suppression (open-source Krisp-style).
 *
 *   mic ─ getUserMedia (echo cancellation, AGC) ─ AudioWorklet (RNNoise | GTCRN) ─ track sent
 *
 * "standard" uses the browser's built-in WebRTC suppressor instead. Models run in an
 * AudioWorklet on the audio thread; they're lazy-loaded chunks, fetched only when used.
 */
export type NoiseSuppression = "off" | "standard" | "gtcrn";

export const noiseSuppressionModes: { value: NoiseSuppression; label: string; hint: string }[] = [
  { value: "gtcrn", label: "AI", hint: "Removes keyboards, clicks, fans and hum, like Krisp." },
  { value: "standard", label: "Standard", hint: "The browser's built-in suppressor. Handles steady noise only." },
  { value: "off", label: "Off", hint: "Raw microphone." },
];

export interface MicOptions {
  deviceId: string | null;
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface Mic {
  /** What gets sent: processed when a model is active. */
  track: MediaStreamTrack;
  /** The suppression actually in effect (falls back to "standard" if a model fails to load). */
  mode: NoiseSuppression;
  setEnabled(on: boolean): void;
  stop(): void;
}

/** Lazy so the model (~260 KB) only downloads when used. */
const loadModel = () => import("./denoise/gtcrn");

function plain(raw: MediaStreamTrack, mode: NoiseSuppression): Mic {
  return {
    track: raw,
    mode,
    setEnabled: (on) => (raw.enabled = on),
    stop: () => raw.stop(),
  };
}

function capture(o: MicOptions, browserSuppression: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: o.deviceId ? { exact: o.deviceId } : undefined,
      echoCancellation: o.echoCancellation,
      // Neural models want the unprocessed signal; stacking suppressors adds artifacts.
      noiseSuppression: browserSuppression,
      autoGainControl: o.autoGainControl,
      channelCount: 1,
      sampleRate: 48000,
    },
  });
}

export async function openMic(o: MicOptions): Promise<Mic> {
  const neural = o.noiseSuppression === "gtcrn";
  const raw = (await capture(o, o.noiseSuppression === "standard")).getAudioTracks()[0];
  if (!raw) throw new Error("no microphone track");
  if (!neural) return plain(raw, o.noiseSuppression);

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const node = await (await loadModel()).createNode(ctx);
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    const dst = ctx.createMediaStreamDestination();
    // The worklet fills only channel 0 of a stereo output; take it as-is rather than
    // averaging it with a silent channel 1 (which would cost 6 dB).
    dst.channelCount = 1;
    dst.channelCountMode = "explicit";
    dst.channelInterpretation = "discrete";
    src.connect(node).connect(dst);
    if (ctx.state === "suspended") await ctx.resume();
    const track = dst.stream.getAudioTracks()[0];
    const c = ctx;
    return {
      track,
      mode: o.noiseSuppression,
      setEnabled: (on) => {
        track.enabled = on;
        raw.enabled = on;
        // No point running the model while muted.
        void (on ? c.resume() : c.suspend()).catch(() => {});
      },
      stop: () => {
        src.disconnect();
        node.disconnect();
        node.destroy();
        track.stop();
        raw.stop();
        void c.close().catch(() => {});
      },
    };
  } catch (e) {
    console.warn(`noise suppression "${o.noiseSuppression}" unavailable, using the browser's`, e);
    void ctx?.close().catch(() => {});
    // Constraints can't reliably be changed on a live track, so capture again.
    raw.stop();
    const fallback = (await capture(o, true)).getAudioTracks()[0];
    if (!fallback) throw new Error("no microphone track");
    return plain(fallback, "standard");
  }
}
