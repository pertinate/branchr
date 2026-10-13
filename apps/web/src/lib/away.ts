/**
 * Going idle: after a while with no input, "online" shows as idle until you're back. On the
 * desktop app that's input anywhere on the system; in a browser, in this page. Not while
 * you're in voice.
 */
import { sendStatus } from "@/lib/actions";
import { desktop } from "@/lib/desktop";
import { useMyStatus } from "@/stores/ui";
import { useVoice } from "@/stores/voice";

const AWAY_AFTER_S = 10 * 60;
const CHECK_MS = 30_000;

function setAway(away: boolean) {
  if (useMyStatus.getState().away === away) return;
  useMyStatus.setState({ away });
  sendStatus();
}

/** Starts watching for being away. Returns a stop function. */
export function startAway(): () => void {
  let lastInput = Date.now();
  const input = () => {
    lastInput = Date.now();
    if (useMyStatus.getState().away) setAway(false);
  };
  const events = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;
  for (const e of events) window.addEventListener(e, input, { passive: true });
  const check = async () => {
    let idle = (Date.now() - lastInput) / 1000;
    if (desktop?.idleSeconds) idle = await desktop.idleSeconds().catch(() => idle);
    setAway(idle >= AWAY_AFTER_S && useVoice.getState().status === "disconnected");
  };
  const timer = setInterval(() => void check(), CHECK_MS);
  return () => {
    clearInterval(timer);
    for (const e of events) window.removeEventListener(e, input);
    setAway(false);
  };
}
