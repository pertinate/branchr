import { useEffect, useRef } from "react";

import { useVoice, useVoiceSettings } from "@/stores/voice";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audioGraph() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return { ctx, master: master! };
}

/**
 * Plays every subscribed audio track through one WebAudio graph: per-user gain (0-200%),
 * a master gain for deafen, and output device selection.
 */
export function AudioRenderer() {
  const subs = useVoice((s) => s.subs);
  const tracks = useVoice((s) => s.tracks);
  const deafened = useVoice((s) => s.deafened);
  const volumes = useVoiceSettings((s) => s.userVolumes);
  const output = useVoiceSettings((s) => s.outputDeviceId);
  const nodes = useRef(new Map<string, { el: HTMLAudioElement; src: MediaStreamAudioSourceNode; gain: GainNode }>());

  useEffect(() => {
    const { ctx, master } = audioGraph();
    const live = new Set<string>();
    for (const [id, sub] of Object.entries(subs)) {
      if (sub.track.kind !== "audio") continue;
      live.add(id);
      if (nodes.current.has(id)) continue;
      const stream = new MediaStream([sub.track]);
      // Chromium only pulls remote WebRTC audio into WebAudio while a media element consumes it.
      const el = new Audio();
      el.srcObject = stream;
      el.muted = true;
      void el.play().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      src.connect(gain).connect(master);
      nodes.current.set(id, { el, src, gain });
    }
    for (const [id, n] of nodes.current) {
      if (live.has(id)) continue;
      n.src.disconnect();
      n.gain.disconnect();
      n.el.srcObject = null;
      nodes.current.delete(id);
    }
    if (ctx.state === "suspended") void ctx.resume();
  }, [subs]);

  useEffect(() => {
    for (const [id, n] of nodes.current) {
      const user = tracks[id]?.userId;
      n.gain.gain.value = user ? (volumes[user] ?? 1) : 1;
    }
  }, [subs, tracks, volumes]);

  useEffect(() => {
    const { master } = audioGraph();
    master.gain.value = deafened ? 0 : 1;
  }, [deafened]);

  useEffect(() => {
    const { ctx } = audioGraph();
    const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    void c.setSinkId?.(output ?? "").catch(() => {});
  }, [output]);

  // Browsers start AudioContexts suspended until a user gesture.
  useEffect(() => {
    const resume = () => void audioGraph().ctx.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    return () => window.removeEventListener("pointerdown", resume);
  }, []);

  return null;
}
