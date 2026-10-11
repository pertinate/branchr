import type { LayerPref, TrackInfo, TrackSource, VoiceClientMsg, VoiceServerMsg } from "@app/protocol";
import { toast } from "sonner";

export interface PublishLayer {
  name: "h" | "m" | "l";
  encoding: RTCRtpEncodingParameters;
}

export interface PublishOptions {
  source: TrackSource;
  encodings?: RTCRtpEncodingParameters[];
  /**
   * Publish each quality layer on its own transceiver (and so its own encoder). Chromium
   * falls back to software encoding for RID simulcast, but gives every transceiver its own
   * hardware encoder session.
   */
  layers?: PublishLayer[];
  /** Preferred codec mime type, e.g. "video/AV1". Other codecs are removed from the offer. */
  codec?: string;
  degradation?: RTCDegradationPreference;
  /** Hint for the sender's initial bandwidth estimate, so high bitrate streams ramp up fast. */
  startBitrateKbps?: number;
}

export interface ConnectionEvents {
  trackAdded: (t: TrackInfo) => void;
  trackRemoved: (trackId: string) => void;
  speaking: (userId: string, speaking: boolean) => void;
  layer: (trackId: string, layer: string | null, estimateBps: number) => void;
  closed: (reason: string) => void;
  /** Media transport up (true) or interrupted (false). */
  media?: (connected: boolean) => void;
}

interface Slot {
  kind: "audio" | "video";
  transceiver: RTCRtpTransceiver;
  trackId: string | null;
}

interface Pending {
  transceiver: RTCRtpTransceiver;
  source: TrackSource;
  group?: string;
  layer?: string;
}

/**
 * One connection to an SFU room. All SDP offers originate here (the SFU only answers),
 * so negotiations are simply serialized on a promise chain.
 */
export class VoiceConnection {
  readonly tracks = new Map<string, TrackInfo>();
  private pc: RTCPeerConnection;
  private slots = new Map<string, Slot>();
  private published = new Map<TrackSource, RTCRtpTransceiver[]>();
  private pendingPublish: Pending[] = [];
  private chain: Promise<void> = Promise.resolve();
  private answerWaiter: ((sdp: string) => void) | null = null;
  private startBitrateKbps = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval>;

  private constructor(
    private ws: WebSocket,
    public readonly peerId: string,
    tracks: TrackInfo[],
    private events: ConnectionEvents,
  ) {
    for (const t of tracks) this.tracks.set(t.id, t);
    this.pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      this.events.media?.(state === "connected");
      if (state === "failed") this.close("media connection failed");
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data) as VoiceServerMsg);
    ws.onclose = () => this.close("signaling closed");
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 15_000);
  }

  static connect(endpoint: string, token: string, events: ConnectionEvents): Promise<VoiceConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("timed out connecting to voice server"));
      }, 10_000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", token } satisfies VoiceClientMsg));
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("could not reach voice server"));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as VoiceServerMsg;
        clearTimeout(timer);
        if (msg.type === "joined") resolve(new VoiceConnection(ws, msg.peerId, msg.tracks, events));
        else if (msg.type === "error") reject(new Error(msg.message));
      };
    });
  }

  private send(msg: VoiceClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: VoiceServerMsg) {
    switch (msg.type) {
      case "answer":
        this.answerWaiter?.(msg.sdp);
        this.answerWaiter = null;
        return;
      case "track_added":
        this.tracks.set(msg.track.id, msg.track);
        this.events.trackAdded(msg.track);
        return;
      case "track_removed":
        this.tracks.delete(msg.trackId);
        for (const s of this.slots.values()) if (s.trackId === msg.trackId) s.trackId = null;
        this.events.trackRemoved(msg.trackId);
        return;
      case "speaking":
        this.events.speaking(msg.userId, msg.speaking);
        return;
      case "layer": {
        const slot = this.slots.get(msg.mid);
        if (slot?.trackId) this.events.layer(slot.trackId, msg.layer, msg.estimateBps);
        return;
      }
      case "error":
        console.warn("[voice]", msg.message);
        if (msg.message.startsWith("replaced")) {
          toast.info("Voice moved to another window", { description: "You joined from somewhere else." });
          this.close(msg.message);
        } else toast.error("Voice error", { description: msg.message });
        return;
      case "joined":
      case "pong":
        return;
    }
  }

  /** Serializes offer/answer exchanges. */
  private negotiate(): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      // mids are assigned by setLocalDescription.
      const pending = this.pendingPublish.splice(0);
      const publish = pending
        .filter((p) => p.transceiver.mid)
        .map((p) => ({ mid: p.transceiver.mid!, source: p.source, group: p.group, layer: p.layer }));
      const answer = new Promise<string>((resolve, reject) => {
        this.answerWaiter = resolve;
        setTimeout(() => reject(new Error("no answer from voice server")), 10_000);
      });
      this.send({ type: "offer", sdp: this.pc.localDescription!.sdp, publish });
      const sdp = await answer;
      await this.pc.setRemoteDescription({ type: "answer", sdp: this.mungeAnswer(sdp) });
      for (const t of this.pc.getTransceivers()) {
        if (t.direction === "recvonly" && t.mid && !this.slots.has(t.mid)) {
          this.slots.set(t.mid, { kind: t.receiver.track.kind as "audio" | "video", transceiver: t, trackId: null });
          // Lowest possible latency for live content.
          const r = t.receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
          if ("jitterBufferTarget" in r) r.jitterBufferTarget = 0;
        }
      }
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /**
   * - Opus: stereo + high max bitrate so stream audio isn't squashed (mic bitrate is still
   *   bounded by the sender encoding's maxBitrate).
   * - Video: raise the starting bandwidth estimate so streams start sharp instead of ramping
   *   up from Chrome's ~300 kbps default.
   */
  private mungeAnswer(sdp: string): string {
    const lines = sdp.split("\r\n");
    const opusPts = new Set<string>();
    const videoPts = new Set<string>();
    for (const l of lines) {
      const m = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(l);
      if (!m) continue;
      const codec = m[2].toLowerCase();
      if (codec === "opus") opusPts.add(m[1]);
      else if (["vp8", "vp9", "av1", "h264", "h265"].includes(codec)) videoPts.add(m[1]);
    }
    const start = this.startBitrateKbps;
    return lines
      .map((l) => {
        const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
        if (!m) return l;
        if (opusPts.has(m[1]) && !m[2].includes("stereo=")) {
          return `${l};stereo=1;sprop-stereo=1;maxaveragebitrate=510000`;
        }
        if (start > 0 && videoPts.has(m[1]) && !m[2].includes("x-google-start-bitrate")) {
          return `${l};x-google-start-bitrate=${start}`;
        }
        return l;
      })
      .join("\r\n");
  }

  /** Initial negotiation: publish the mic (if any) and pre-allocate audio slots. */
  async start(mic: MediaStreamTrack | null) {
    const audioTracks = [...this.tracks.values()].filter((t) => t.kind === "audio").length;
    if (mic) {
      const t = this.pc.addTransceiver(mic, {
        direction: "sendonly",
        sendEncodings: [{ maxBitrate: 128_000, priority: "high", networkPriority: "high" }],
      });
      this.published.set("mic", [t]);
      this.pendingPublish.push({ transceiver: t, source: "mic" });
    }
    // At least one m-line is required for ICE even when listening only.
    for (let i = 0; i < Math.max(1, audioTracks + 1); i++) this.pc.addTransceiver("audio", { direction: "recvonly" });
    await this.negotiate();
  }

  async publish(track: MediaStreamTrack, opts: PublishOptions): Promise<RTCRtpSender> {
    await this.unpublish(opts.source);
    if (opts.startBitrateKbps) this.startBitrateKbps = Math.max(this.startBitrateKbps, opts.startBitrateKbps);
    const layers = opts.layers ?? [{ name: "h" as const, encoding: {} }];
    const grouped = !!opts.layers && opts.layers.length > 1;
    const group = grouped ? opts.source : undefined;
    const transceivers = layers.map((layer, i) => {
      // Clones share the capture; each feeds its own encoder.
      const t = this.pc.addTransceiver(i === 0 ? track : track.clone(), {
        direction: "sendonly",
        sendEncodings: opts.layers ? [layer.encoding] : opts.encodings,
      });
      if (opts.codec && track.kind === "video") {
        const caps = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
        const preferred = caps.filter((c) => c.mimeType.toLowerCase() === opts.codec!.toLowerCase());
        // Keep resiliency codecs so NACK/RTX keeps working.
        const support = caps.filter((c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType));
        if (preferred.length) t.setCodecPreferences([...preferred, ...support]);
      }
      this.pendingPublish.push({ transceiver: t, source: opts.source, group, layer: grouped ? layer.name : undefined });
      return t;
    });
    this.published.set(opts.source, transceivers);
    await this.negotiate();
    if (opts.degradation) {
      for (const t of transceivers) {
        const p = t.sender.getParameters();
        p.degradationPreference = opts.degradation;
        await t.sender.setParameters(p).catch(() => {});
      }
    }
    return transceivers[0].sender;
  }

  async unpublish(source: TrackSource) {
    const ts = this.published.get(source);
    if (!ts) return;
    this.published.delete(source);
    for (const t of ts) {
      if (t.mid) this.send({ type: "unpublish", mid: t.mid });
      t.sender.track?.stop();
      t.stop();
    }
    await this.negotiate();
  }

  /** Replace a published track in place (e.g. switching microphones) without renegotiating. */
  async replaceTrack(source: TrackSource, track: MediaStreamTrack) {
    const t = this.published.get(source)?.[0];
    if (t) await t.sender.replaceTrack(track);
  }

  sender(source: TrackSource): RTCRtpSender | null {
    return this.published.get(source)?.[0]?.sender ?? null;
  }

  /** Points a free receive slot at a remote track and returns the local MediaStreamTrack. */
  async subscribe(trackId: string): Promise<{ track: MediaStreamTrack; mid: string } | null> {
    const info = this.tracks.get(trackId);
    if (!info) return null;
    for (const [mid, s] of this.slots) if (s.trackId === trackId) return { track: s.transceiver.receiver.track, mid };
    let entry = [...this.slots.entries()].find(([, s]) => s.kind === info.kind && s.trackId === null);
    if (!entry) {
      const t = this.pc.addTransceiver(info.kind, { direction: "recvonly" });
      await this.negotiate();
      if (!t.mid) return null;
      const slot = this.slots.get(t.mid);
      if (!slot) return null;
      entry = [t.mid, slot];
    }
    const [mid, slot] = entry;
    // Another subscribe may have grabbed it while we were negotiating.
    if (slot.trackId !== null && slot.trackId !== trackId) return this.subscribe(trackId);
    slot.trackId = trackId;
    this.send({ type: "subscribe", mid, trackId });
    return { track: slot.transceiver.receiver.track, mid };
  }

  unsubscribe(trackId: string) {
    for (const [mid, s] of this.slots) {
      if (s.trackId === trackId) {
        s.trackId = null;
        this.send({ type: "unsubscribe", mid });
      }
    }
  }

  setLayer(trackId: string, layer: LayerPref) {
    for (const [mid, s] of this.slots) if (s.trackId === trackId) this.send({ type: "set_layer", mid, layer });
  }

  receiver(trackId: string): RTCRtpReceiver | null {
    for (const s of this.slots.values()) if (s.trackId === trackId) return s.transceiver.receiver;
    return null;
  }

  close(reason = "closed") {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const ts of this.published.values()) for (const t of ts) t.sender.track?.stop();
    this.ws.onclose = null;
    this.ws.close();
    this.pc.close();
    this.events.closed(reason);
  }

  get isClosed() {
    return this.closed;
  }
}
