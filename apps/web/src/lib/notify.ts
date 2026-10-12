import type { Message } from "@app/protocol";

import { desktop } from "@/lib/desktop";
import { type Instance, instance, instances, useActive, useInstanceList } from "@/lib/instances";
import { mentionsMe, plainText } from "@/lib/mentions";

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
function notifyMention(inst: Instance, m: Message) {
  const s = inst.app.getState();
  const onScreen = useActive.getState().id === inst.id && s.viewing === m.channelId;
  if (onScreen && document.hasFocus()) return;
  chime();
  const channel = s.channels[m.channelId];
  const guildId = channel?.guildId;
  const guild = guildId ? s.guilds[guildId] : undefined;
  const author = (guildId && s.members[guildId]?.[m.author.id]?.nick) || m.author.displayName;
  const title = `${author} (#${channel?.name ?? "unknown"}${guild ? `, ${guild.name}` : ""})`;
  const body = plainText(m, guildId, s) || (m.attachments.length ? "Sent an attachment" : "");
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
 * Mention notifications from every instance, plus the unread-mention count across all of
 * them on the taskbar badge and in the title. Returns a stop function.
 */
export function startNotifications(): () => void {
  // Browsers ask once; desktop builds always may.
  if (!desktop && typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {});
  }
  const base = document.title;
  let last = -1;
  const badge = () => {
    let total = 0;
    for (const i of instances()) for (const n of Object.values(i.app.getState().pings)) total += n;
    if (total === last) return;
    last = total;
    desktop?.setBadge(total);
    document.title = total ? `(${total}) ${base}` : base;
  };
  // Instances come and go (log in, log out); follow them.
  const attached = new Map<string, () => void>();
  const attach = () => {
    for (const inst of instances()) {
      if (attached.has(inst.id)) continue;
      const offGateway = inst.gateway.on((ev) => {
        if (ev.t === "MESSAGE_CREATE" && mentionsMe(ev.d, inst.app.getState())) notifyMention(inst, ev.d);
      });
      const offStore = inst.app.subscribe((s, prev) => s.pings !== prev.pings && badge());
      attached.set(inst.id, () => {
        offGateway();
        offStore();
      });
    }
    for (const [id, off] of attached) {
      if (instance(id)) continue;
      off();
      attached.delete(id);
    }
    badge();
  };
  attach();
  const offList = useInstanceList.subscribe(attach);
  return () => {
    offList();
    for (const off of attached.values()) off();
    desktop?.setBadge(0);
    document.title = base;
  };
}
