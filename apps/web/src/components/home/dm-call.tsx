import type { Person } from "@app/protocol";
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { asUser } from "@/components/home/person-avatar";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import { useSocial } from "@/lib/social";
import { useVoice } from "@/stores/voice";

/** Header button: start (or join) the conversation's call. */
export function CallButton({ channelId }: { channelId: string }) {
  const inThis = useVoice((s) => s.call === channelId && s.status !== "disconnected");
  if (inThis) return null;
  return (
    <Button size="sm" variant="ghost" aria-label="Start Voice Call" onClick={() => void useVoice.getState().joinCall(channelId)}>
      <Phone />
    </Button>
  );
}

function CameraTile({ track }: { track: MediaStreamTrack }) {
  const el = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (el.current) el.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <video ref={el} autoPlay playsInline muted className="size-full object-cover" />;
}

/** One person in the call: their camera if on, else their avatar; ringed while speaking. */
function Tile({ person, voiceId, me }: { person: Person; voiceId: string; me: boolean }) {
  const speaking = useVoice((s) => !!s.speaking[voiceId]);
  const localCamera = useVoice((s) => (me ? s.camera : null));
  const remote = useVoice((s) => {
    const t = Object.values(s.tracks).find((t) => t.userId === voiceId && t.source === "camera");
    return t ? s.subs[t.id]?.track : undefined;
  });
  const localEl = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (localEl.current) localEl.current.srcObject = localCamera;
  }, [localCamera]);
  return (
    <div
      data-testid="call-tile"
      className={cn("relative grid h-36 w-56 place-items-center overflow-hidden rounded-lg bg-black/40 transition-shadow", speaking && "ring-2 ring-online")}
    >
      {localCamera ? (
        <video ref={localEl} autoPlay playsInline muted className="size-full -scale-x-100 object-cover" />
      ) : remote ? (
        <CameraTile track={remote} />
      ) : (
        <UserAvatar user={asUser(person)} size={72} speaking={speaking} />
      )}
      <span className="absolute bottom-1 left-2 rounded bg-black/50 px-1.5 text-xs text-white">{person.displayName}</span>
    </div>
  );
}

/** The call area above a DM: who's in it, and your controls, or a way to join. */
export function DmCall({ channelId }: { channelId: string }) {
  const call = useSocial((s) => s.calls[channelId]);
  const me = useSocial((s) => s.me);
  const people = useSocial(useShallow((s) => s.channels[channelId]?.recipients ?? []));
  const v = useVoice(useShallow((s) => ({ inThis: s.call === channelId && s.status !== "disconnected", status: s.status, muted: s.muted, camera: !!s.camera })));
  if (!call || !me) return null;
  const everyone = [me, ...people];
  const inCall = call.participants.map((p) => ({ ...p, person: everyone.find((x) => x.id === p.id) })).filter((p) => p.person);
  return (
    <div className="shrink-0 border-b border-black/20 bg-black/30 px-4 py-4" data-testid="dm-call">
      <div className="flex flex-wrap justify-center gap-3">
        {inCall.map((p) => (
          <Tile key={p.id} person={p.person!} voiceId={p.voiceId} me={p.id === me.id} />
        ))}
      </div>
      <div className="mt-3 flex justify-center gap-2">
        {v.inThis ? (
          <>
            <Button size="sm" variant={v.muted ? "destructive" : "secondary"} aria-label={v.muted ? "Unmute" : "Mute"} onClick={() => useVoice.getState().toggleMute()}>
              {v.muted ? <MicOff /> : <Mic />}
            </Button>
            <Button
              size="sm"
              variant={v.camera ? "default" : "secondary"}
              aria-label={v.camera ? "Turn Off Camera" : "Turn On Camera"}
              onClick={() => void useVoice.getState().toggleCamera().catch((e: Error) => toast.error(`Camera: ${e.message}`))}
            >
              {v.camera ? <Video /> : <VideoOff />}
            </Button>
            <Button size="sm" variant="destructive" aria-label="Leave Call" onClick={() => useVoice.getState().leave()}>
              <PhoneOff />
            </Button>
            {v.status !== "connected" && <span className="self-center text-xs text-muted-foreground">Connecting…</span>}
          </>
        ) : (
          <Button size="sm" className="bg-online text-white hover:bg-online/90" onClick={() => void useVoice.getState().joinCall(channelId)}>
            <Phone /> Join Call
          </Button>
        )}
      </div>
    </div>
  );
}
