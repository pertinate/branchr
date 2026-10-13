import type { Channel } from "@app/protocol";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useInstance } from "@/lib/instances";

/** Names a new thread, from a message or a channel, then opens it. */
export function CreateThreadDialog({ channelId, messageId, suggested, onClose }: { channelId: string; messageId?: string; suggested: string; onClose: () => void }) {
  const inst = useInstance();
  const navigate = useNavigate();
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await inst.api<Channel>("POST", `/channels/${channelId}/threads`, { name: name.trim() || undefined, messageId });
      inst.app.getState().apply({ t: "CHANNEL_CREATE", d: t });
      onClose();
      void navigate({ to: "/$guildId/$channelId", params: { guildId: t.guildId, channelId: t.id } });
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Thread</DialogTitle>
          <DialogDescription>A side conversation, open to everyone who can see the channel.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Thread name" aria-label="Thread name" />
          <Button type="submit" disabled={busy}>
            Create Thread
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
