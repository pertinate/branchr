import type { LayerPref, TrackInfo, VoiceServer } from "@app/protocol";
import { toast } from "sonner";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { desktop } from "@/lib/desktop";
import { type Instance, activeInstance, instance, useInstanceList } from "@/lib/instances";
import { joinCall as joinCallServer, leaveCall } from "@/lib/social";
import { VoiceConnection } from "@/voice/connection";
import { type Mic, type NoiseSuppression, openMic } from "@/voice/mic";
import { type StreamSettings, cameraEncodings, defaultStreamSettings, layersFor, pickCodec } from "@/voice/presets";

/** "connected" means media is flowing, not just that signaling succeeded. */
export type VoiceStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface Subscription {
  track: MediaStreamTrack;
  layer: string | null;
  pref: LayerPref;
}

interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  autoGainControl: boolean;
  stream: StreamSettings;
  /** user id -> 0..2 */
  userVolumes: Record<string, number>;
  setSettings: (p: Partial<Omit<VoiceSettings, "setSettings">>) => void;
}

export const useVoiceSettings = create<VoiceSettings>()(
  persist(
    (set) => ({
      inputDeviceId: null,
      outputDeviceId: null,
      noiseSuppression: "gtcrn",
      echoCancellation: true,
      autoGainControl: true,
      stream: defaultStreamSettings,
      userVolumes: {},
      setSettings: (p) => set(p),
    }),
    {
      name: "voice-settings",
      version: 1,
      // v0 stored noise suppression as an on/off switch.
      migrate: (old, version) => {
        const o = old as Record<string, unknown>;
        if (version < 1) o.noiseSuppression = o.noiseSuppression === false ? "off" : "gtcrn";
        return o as unknown as VoiceSettings;
      },
    },
  ),
);

interface VoiceState {
  status: VoiceStatus;
  /** The instance this voice channel is on (voice stays up while browsing others). */
  instanceId: string | null;
  guildId: string | null;
  /** The voice channel, or the DM when in a call. */
  channelId: string | null;
  /** Set when this is a call in a DM (on branchr ID) rather than a server voice channel. */
  call: string | null;
  error: string | null;
  muted: boolean;
  deafened: boolean;
  camera: MediaStream | null;
  screen: MediaStream | null;
  screenSender: RTCRtpSender | null;
  tracks: Record<string, TrackInfo>;
  subs: Record<string, Subscription>;
  /** Screen shares the user chose to watch. */
  watching: string[];
  speaking: Record<string, boolean>;
  estimateBps: number;

  /** Joins a channel on `instanceId` (default: the instance on screen). */
  join: (guildId: string, channelId: string, instanceId?: string) => Promise<void>;
  /** Joins (or starts) the call in a DM. */
  joinCall: (dmChannelId: string) => Promise<void>;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  startStream: (settings: StreamSettings) => Promise<void>;
  stopStream: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  watch: (trackId: string) => Promise<void>;
  unwatch: (trackId: string) => void;
  setLayer: (trackId: string, pref: LayerPref) => void;
  reloadMic: () => Promise<void>;
  connection: () => VoiceConnection | null;
}

let conn: VoiceConnection | null = null;
let mic: Mic | null = null;
let joinSeq = 0;
let venmicActive = false;

/** Captures the venmic virtual microphone (appears shortly after linking). */
async function captureVenmic(appName: string | null): Promise<MediaStreamTrack | null> {
  if (!desktop?.audio || !(await desktop.audio.available())) return null;
  if (!(await desktop.audio.start(appName))) return null;
  venmicActive = true;
  for (let i = 0; i < 20; i++) {
    const dev = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label.includes("vencord-screen-share"));
    if (dev) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: dev.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
        },
      });
      return s.getAudioTracks()[0] ?? null;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function stopVenmic() {
  if (venmicActive) void desktop?.audio?.stop();
  venmicActive = false;
}
let retries = 0;

function waitForVoiceServer(inst: Instance, channelId: string): Promise<VoiceServer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("voice server did not respond"));
    }, 10_000);
    const off = inst.gateway.on((ev) => {
      if (ev.t === "VOICE_SERVER" && ev.d.channelId === channelId) {
        clearTimeout(timer);
        off();
        resolve(ev.d);
      }
    });
  });
}

/** Browsers only expose capture APIs on https (or localhost); the desktop app always has them. */
export function mediaUnavailableReason(): string | null {
  if (navigator.mediaDevices) return null;
  return window.isSecureContext
    ? "This browser doesn't support audio/video capture."
    : "Voice and streaming need HTTPS. Serve this instance over https:// or use the desktop app.";
}

async function getMic(): Promise<Mic | null> {
  if (mediaUnavailableReason()) return null;
  const s = useVoiceSettings.getState();
  try {
    const mic = await openMic({
      deviceId: s.inputDeviceId,
      noiseSuppression: s.noiseSuppression,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGainControl,
    });
    if (mic.mode !== s.noiseSuppression) toast.warning("AI noise suppression couldn't load", { description: "Using the standard suppressor instead." });
    return mic;
  } catch (e) {
    console.warn("microphone unavailable", e);
    toast.error("Microphone unavailable", { description: `${(e as Error).message}. You can still listen.` });
    return null;
  }
}

/** Mic and camera audio are subscribed automatically; screens are opt-in (they're expensive). */
function autoSubscribe(t: TrackInfo): boolean {
  return t.source === "mic" || t.source === "camera";
}

const leaveOp = (guildId: string) =>
  ({ op: "voice_state_update", d: { guildId, channelId: null, selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false } }) as const;

export const useVoice = create<VoiceState>()((set, get) => {
  /** The instance the current voice channel is on. */
  const voiceInstance = () => instance(get().instanceId);
  const syncState = () => {
    const s = get();
    if (!s.guildId || !s.channelId) return;
    voiceInstance()?.gateway.send({
      op: "voice_state_update",
      d: {
        guildId: s.guildId,
        channelId: s.channelId,
        selfMute: s.muted || s.deafened,
        selfDeaf: s.deafened,
        selfVideo: !!s.camera,
        selfStream: !!s.screen,
      },
    });
  };

  const subscribe = async (trackId: string, pref: LayerPref = "auto") => {
    if (!conn || get().subs[trackId]) return;
    const res = await conn.subscribe(trackId);
    if (!res) return;
    set((s) => ({ subs: { ...s.subs, [trackId]: { track: res.track, layer: null, pref } } }));
    if (pref !== "auto") conn.setLayer(trackId, pref);
  };

  const dropSub = (trackId: string) => {
    set((s) => {
      const { [trackId]: _, ...subs } = s.subs;
      return { subs, watching: s.watching.filter((w) => w !== trackId) };
    });
  };

  const onTrackAdded = (t: TrackInfo) => {
    set((s) => ({ tracks: { ...s.tracks, [t.id]: t } }));
    if (autoSubscribe(t)) void subscribe(t.id);
    // Stream audio follows the stream video: subscribe if we're watching that user's screen.
    if (t.source === "screen_audio") {
      const watchingUser = get().watching.some((w) => get().tracks[w]?.userId === t.userId);
      if (watchingUser) void subscribe(t.id);
    }
  };

  const cleanup = () => {
    // Clear first: close() fires the `closed` callback, which must not see this as a drop.
    const c = conn;
    conn = null;
    c?.close();
    mic?.stop();
    mic = null;
    const { camera, screen } = get();
    camera?.getTracks().forEach((t) => t.stop());
    screen?.getTracks().forEach((t) => t.stop());
    stopVenmic();
    set({
      camera: null,
      screen: null,
      screenSender: null,
      tracks: {},
      subs: {},
      watching: [],
      speaking: {},
    });
  };

  /**
   * Opens the mic and connects to the SFU once `server` says where; shared by server voice
   * channels and DM calls. `fail` undoes the join elsewhere; `rejoin` retries after a drop.
   */
  const connect = async (seq: number, server: Promise<{ endpoint: string; token: string }>, fail: () => void, rejoin: () => Promise<void>) => {
    try {
      const [vs, opened] = await Promise.all([server, getMic()]);
      if (seq !== joinSeq) {
        opened?.stop();
        return;
      }
      mic = opened;
      mic?.setEnabled(!get().muted && !get().deafened);
      const c = await VoiceConnection.connect(vs.endpoint, vs.token, {
        trackAdded: onTrackAdded,
        trackRemoved: (id) => {
          set((s) => {
            const { [id]: _, ...tracks } = s.tracks;
            return { tracks };
          });
          dropSub(id);
        },
        speaking: (userId, speaking) => set((s) => ({ speaking: { ...s.speaking, [userId]: speaking } })),
        layer: (trackId, layer, estimateBps) =>
          set((s) => (s.subs[trackId] ? { subs: { ...s.subs, [trackId]: { ...s.subs[trackId], layer } }, estimateBps } : {})),
        media: (up) => {
          if (conn !== c && conn !== null) return;
          const st = get().status;
          if (up && st !== "connected") {
            set({ status: "connected" });
            retries = 0;
          } else if (!up && st === "connected") {
            set({ status: "reconnecting" });
          }
        },
        closed: (reason) => {
          if (conn !== c) return;
          conn = null;
          if (reason.startsWith("replaced")) {
            cleanup();
            set({ status: "disconnected", instanceId: null, guildId: null, channelId: null });
            return;
          }
          // Unexpected drop: rejoin with backoff.
          const { channelId: ch } = get();
          if (ch && retries < 5) {
            retries++;
            set({ status: "reconnecting" });
            const mySeq = joinSeq;
            setTimeout(() => {
              // Skip if the user left or switched channels meanwhile.
              if (joinSeq === mySeq && get().channelId === ch) void rejoin();
            }, 1000 * retries);
          } else {
            get().leave();
            set({ error: reason });
          }
        },
      });
      if (seq !== joinSeq) {
        c.close();
        return;
      }
      conn = c;
      await c.start(mic?.track ?? null);
      // Status flips to "connected" from the media callback once ICE/DTLS are up.
      set({ tracks: Object.fromEntries([...c.tracks].map(([k, v]) => [k, v])) });
      for (const t of c.tracks.values()) if (autoSubscribe(t)) void subscribe(t.id);
    } catch (e) {
      if (seq !== joinSeq) return;
      cleanup();
      fail();
      set({ status: "disconnected", instanceId: null, guildId: null, channelId: null, call: null, error: (e as Error).message });
      toast.error("Couldn't join voice", { description: (e as Error).message });
    }
  };

  return {
    status: "disconnected",
    instanceId: null,
    guildId: null,
    channelId: null,
    call: null,
    error: null,
    muted: false,
    deafened: false,
    camera: null,
    screen: null,
    screenSender: null,
    tracks: {},
    subs: {},
    watching: [],
    speaking: {},
    estimateBps: 0,

    connection: () => conn,

    join: async (guildId, channelId, instanceId) => {
      const s = get();
      const inst = instance(instanceId) ?? activeInstance();
      if (s.instanceId === inst.id && s.channelId === channelId && (s.status === "connected" || s.status === "connecting")) return;
      const seq = ++joinSeq;
      cleanup();
      // Moving to another instance's voice: leave the old one there (or hang up a call).
      if (s.instanceId && s.instanceId !== inst.id && s.guildId) instance(s.instanceId)?.gateway.send(leaveOp(s.guildId));
      if (s.call) void leaveCall(s.call);
      set({ status: s.status === "reconnecting" ? "reconnecting" : "connecting", instanceId: inst.id, guildId, channelId, call: null, error: null });

      // Leaving first guarantees the API issues a fresh voice token even for the same channel.
      const app = inst.app.getState();
      const inVoice = app.me && Object.values(app.voice).some((g) => g[app.me!.id]);
      if (inVoice) inst.gateway.send(leaveOp(guildId));

      const server = waitForVoiceServer(inst, channelId);
      syncState();
      await connect(seq, server, () => inst.gateway.send(leaveOp(guildId)), () => get().join(guildId, channelId, inst.id));
    },

    joinCall: async (dmChannelId) => {
      const s = get();
      if (s.call === dmChannelId && (s.status === "connected" || s.status === "connecting")) return;
      const seq = ++joinSeq;
      cleanup();
      // Out of any server voice channel first (one call at a time).
      if (s.instanceId && s.guildId) instance(s.instanceId)?.gateway.send(leaveOp(s.guildId));
      if (s.call && s.call !== dmChannelId) void leaveCall(s.call);
      set({ status: "connecting", instanceId: null, guildId: null, channelId: dmChannelId, call: dmChannelId, error: null });
      await connect(seq, joinCallServer(dmChannelId), () => void leaveCall(dmChannelId), () => get().joinCall(dmChannelId));
    },

    leave: () => {
      joinSeq++;
      const { guildId, call } = get();
      cleanup();
      if (guildId) voiceInstance()?.gateway.send(leaveOp(guildId));
      if (call) void leaveCall(call);
      set({ status: "disconnected", instanceId: null, guildId: null, channelId: null, call: null });
    },

    toggleMute: () => {
      const muted = !get().muted;
      // Unmuting while deafened undeafens too, like Discord.
      const deafened = muted ? get().deafened : false;
      set({ muted, deafened });
      mic?.setEnabled(!muted && !deafened);
      syncState();
    },

    toggleDeafen: () => {
      const deafened = !get().deafened;
      set({ deafened });
      mic?.setEnabled(!get().muted && !deafened);
      syncState();
    },

    startStream: async (settings) => {
      if (!conn) return;
      const unavailable = mediaUnavailableReason();
      if (unavailable) throw new Error(unavailable);
      const heightCap = settings.resolution === "source" ? undefined : Number(settings.resolution);
      // Linux desktop: Chromium can't capture app audio, venmic does it via PipeWire.
      const useVenmic = settings.audio && !!desktop?.audio && desktop.platform === "linux" && (await desktop.audio.available());
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: settings.fps, max: settings.fps },
          height: heightCap ? { max: heightCap } : undefined,
        },
        audio: settings.audio && !useVenmic
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }
          : false,
        // Chromium-specific hints: don't offer the current tab, prefer whole screens.
        selfBrowserSurface: "exclude",
        systemAudio: "include",
      } as DisplayMediaStreamOptions);
      const video = stream.getVideoTracks()[0];
      video.contentHint = settings.content === "game" ? "motion" : "detail";
      const vs = video.getSettings();
      const width = vs.width ?? 1920;
      const height = vs.height ?? 1080;
      const { layers, maxBitrate } = layersFor(settings, width, height);
      const codec = await pickCodec(settings.codec, width, height, settings.fps);
      const sender = await conn.publish(video, {
        source: "screen",
        layers,
        codec,
        degradation: settings.content === "game" ? "maintain-framerate" : "maintain-resolution",
        startBitrateKbps: Math.min(Math.round(maxBitrate / 1000), 15_000),
      });
      const audio = useVenmic ? await captureVenmic(settings.audioApp ?? null) : stream.getAudioTracks()[0];
      if (audio && useVenmic) stream.addTrack(audio);
      if (audio) {
        await conn.publish(audio, { source: "screen_audio", encodings: [{ maxBitrate: 256_000, priority: "high" }] });
      }
      video.addEventListener("ended", () => void get().stopStream());
      set({ screen: stream, screenSender: sender });
      useVoiceSettings.getState().setSettings({ stream: settings });
      syncState();
    },

    stopStream: async () => {
      const { screen } = get();
      if (!screen) return;
      set({ screen: null, screenSender: null });
      screen.getTracks().forEach((t) => t.stop());
      stopVenmic();
      await conn?.unpublish("screen");
      await conn?.unpublish("screen_audio");
      syncState();
    },

    toggleCamera: async () => {
      if (!conn) return;
      const { camera } = get();
      const unavailable = mediaUnavailableReason();
      if (unavailable) throw new Error(unavailable);
      if (camera) {
        set({ camera: null });
        camera.getTracks().forEach((t) => t.stop());
        await conn.unpublish("camera");
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        });
        await conn.publish(stream.getVideoTracks()[0], { source: "camera", encodings: cameraEncodings });
        set({ camera: stream });
      }
      syncState();
    },

    watch: async (trackId) => {
      if (get().watching.includes(trackId)) return;
      set((s) => ({ watching: [...s.watching, trackId] }));
      await subscribe(trackId);
      const t = get().tracks[trackId];
      const audio = Object.values(get().tracks).find((x) => x.userId === t?.userId && x.source === "screen_audio");
      if (audio) await subscribe(audio.id);
    },

    unwatch: (trackId) => {
      const t = get().tracks[trackId];
      conn?.unsubscribe(trackId);
      dropSub(trackId);
      const audio = Object.values(get().tracks).find((x) => x.userId === t?.userId && x.source === "screen_audio");
      if (audio) {
        conn?.unsubscribe(audio.id);
        dropSub(audio.id);
      }
    },

    setLayer: (trackId, pref) => {
      conn?.setLayer(trackId, pref);
      set((s) => (s.subs[trackId] ? { subs: { ...s.subs, [trackId]: { ...s.subs[trackId], pref } } } : {}));
    },

    reloadMic: async () => {
      if (!conn) return;
      const next = await getMic();
      if (!next) return;
      if (!conn) return next.stop();
      next.setEnabled(!get().muted && !get().deafened);
      await conn.replaceTrack("mic", next.track);
      mic?.stop();
      mic = next;
    },
  };
});

// Logging out of the instance the call is on hangs up.
useInstanceList.subscribe(({ ids }) => {
  const { instanceId, leave } = useVoice.getState();
  if (instanceId && !ids.includes(instanceId)) leave();
});
