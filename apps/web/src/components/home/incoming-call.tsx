import { useNavigate } from "@tanstack/react-router";
import { Phone, PhoneOff } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { declineCall, dmTitle, useSocial } from "@/lib/social";
import { useVoice } from "@/stores/voice";

/** A rising two-note ring, every two seconds while ringing. */
function useRing(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let ctx: AudioContext | null = null;
    const ring = () => {
      try {
        ctx ??= new AudioContext();
        const t = ctx.currentTime;
        for (const [freq, at] of [[660, 0], [880, 0.25]] as const) {
          const gain = ctx.createGain();
          gain.connect(ctx.destination);
          gain.gain.setValueAtTime(0.0001, t + at);
          gain.gain.exponentialRampToValueAtTime(0.12, t + at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.4);
          const osc = ctx.createOscillator();
          osc.frequency.value = freq;
          osc.connect(gain);
          osc.start(t + at);
          osc.stop(t + at + 0.4);
        }
      } catch {
        /* no audio */
      }
    };
    ring();
    const timer = setInterval(ring, 2000);
    return () => {
      clearInterval(timer);
      void ctx?.close();
    };
  }, [active]);
}

/** Calls ringing for us, wherever we are in the app. */
export function IncomingCall() {
  const navigate = useNavigate();
  const ringing = useSocial(
    useShallow((s) => (s.me ? Object.values(s.calls).filter((c) => c.ringing.includes(s.me!.id)).map((c) => c.channelId) : [])),
  );
  const inCall = useVoice((s) => s.call);
  const shown = ringing.filter((id) => id !== inCall);
  const channels = useSocial((s) => s.channels);
  useRing(shown.length > 0);
  if (!shown.length) return null;
  return (
    <div className="fixed right-4 bottom-4 z-50 space-y-2">
      {shown.map((cid) => {
        const c = channels[cid];
        return (
          <div key={cid} role="alertdialog" aria-label="Incoming call" className="w-72 rounded-lg border border-border bg-popover p-4 shadow-xl">
            <div className="text-xs text-muted-foreground uppercase">Incoming call</div>
            <div className="mt-1 truncate text-lg font-semibold">{c ? dmTitle(c) : "Someone"}</div>
            <div className="mt-3 flex gap-2">
              <Button
                className="flex-1 bg-online text-white hover:bg-online/90"
                onClick={() => {
                  void useVoice.getState().joinCall(cid);
                  void navigate({ to: "/home/$channelId", params: { channelId: cid } });
                }}
              >
                <Phone /> Accept
              </Button>
              <Button variant="destructive" className="flex-1" onClick={() => void declineCall(cid)}>
                <PhoneOff /> Decline
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
