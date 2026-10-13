import type { Channel, ChannelKind } from "@app/protocol";
import { useNavigate } from "@tanstack/react-router";
import { Hash, Volume2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useInstance } from "@/lib/instances";
import { cn } from "@/lib/utils";

export function CreateChannelDialog(props: {
  guildId: string;
  parentId: string | null;
  /** What's picked to start with. */
  kind?: ChannelKind;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [kind, setKind] = useState<ChannelKind>(props.kind ?? "text");
  const [name, setName] = useState("");
  const navigate = useNavigate();
  // The rail can open this for an instance other than the one on screen.
  const inst = useInstance();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await inst.api<Channel>("POST", `/guilds/${props.guildId}/channels`, { name, kind, parentId: props.parentId });
      inst.app.getState().apply({ t: "CHANNEL_CREATE", d: c });
      props.onOpenChange(false);
      setName("");
      if (c.kind === "text") void navigate({ to: "/$guildId/$channelId", params: { guildId: c.guildId, channelId: c.id } });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Channel</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          {(["text", "voice", "category"] as const).map((k) => (
            <button
              type="button"
              key={k}
              onClick={() => setKind(k)}
              className={cn("flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left", kind === k ? "border-primary bg-accent" : "border-border hover:bg-accent/50")}
            >
              {k === "voice" ? <Volume2 className="size-5" /> : <Hash className="size-5" />}
              <div>
                <div className="font-medium capitalize">{k}</div>
                <div className="text-xs text-muted-foreground">
                  {k === "text" ? "Messages, emotes, opinions and puns" : k === "voice" ? "Hang out with voice, video, and screen/game streaming" : "Group channels together"}
                </div>
              </div>
            </button>
          ))}
          {props.parentId && kind === "category" && <p className="text-xs text-destructive">Categories can't be nested.</p>}
          <Input autoFocus placeholder={kind === "text" ? "new-channel" : "New Channel"} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          <Button type="submit" className="w-full" disabled={!name.trim() || (!!props.parentId && kind === "category")}>Create Channel</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
