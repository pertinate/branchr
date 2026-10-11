import type { Message } from "@app/protocol";

import { desktop } from "@/lib/desktop";
import { gateway } from "@/lib/gateway";
import { mentionsMe, plainText } from "@/lib/mentions";
import { useApp } from "@/stores/app";

/** A short two-note chime, synthesized so there's no asset to ship. */
let audio: AudioContext | null = null;
function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const gain = audio.createGain();
    gain.connect(audio.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    for (const [freq, at] of [[880, 0], [1320, 0.08]] as const) {
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(t + at);
      osc.stop(t + 0.35);
    }
  } catch {
    /* no audio output */
  }
}

/** Notifies about a message that mentions us, unless it's on screen in a focused window. */
function notifyMention(m: Message) {
  const s = useApp.getState();
  if (s.viewing === m.channelId && document.hasFocus()) return;
  chime();
  const channel = s.channels[m.channelId];
  const guildId = channel?.guildId;
  const guild = guildId ? s.guilds[guildId] : undefined;
  const author = (guildId && s.members[guildId]?.[m.author.id]?.nick) || m.author.displayName;
  const title = `${author} (#${channel?.name ?? "unknown"}${guild ? `, ${guild.name}` : ""})`;
  const body = plainText(m, guildId) || (m.attachments.length ? "Sent an attachment" : "");
  if (desktop) return desktop.notify(title, body);
  if (typeof Notification === "undefined" || document.hasFocus()) return;
  if (Notification.permission === "granted") {
    const n = new Notification(title, { body, icon: "/icon.png", tag: m.id });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }
}

/**
 * Mention notifications, plus the unread-mention count on the taskbar badge and in the
 * title. Returns a stop function.
 */
export function startNotifications(): () => void {
  // Browsers ask once; desktop builds always may.
  if (!desktop && typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {});
  }
  const offGateway = gateway.on((ev) => {
    if (ev.t === "MESSAGE_CREATE" && mentionsMe(ev.d, useApp.getState().me?.id)) notifyMention(ev.d);
  });
  const base = document.title;
  let last = -1;
  const badge = (pings: Record<string, number>) => {
    let total = 0;
    for (const n of Object.values(pings)) total += n;
    if (total === last) return;
    last = total;
    desktop?.setBadge(total);
    document.title = total ? `(${total}) ${base}` : base;
  };
  badge(useApp.getState().pings);
  const offStore = useApp.subscribe((s) => badge(s.pings));
  return () => {
    offGateway();
    offStore();
    desktop?.setBadge(0);
    document.title = base;
  };
}
