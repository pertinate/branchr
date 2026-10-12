import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { FriendPicker } from "@/components/home/friend-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createGroup, openDm } from "@/lib/social";

const MAX_OTHERS = 9;

/** Start a conversation: one friend opens your DM with them, more makes a group. */
export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const c = picked.length === 1 && !name.trim() ? await openDm(picked[0]) : await createGroup(picked, name.trim() || undefined);
      onClose();
      void navigate({ to: "/home/$channelId", params: { channelId: c.id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Friends</DialogTitle>
          <DialogDescription>You can add {MAX_OTHERS - picked.length} more.</DialogDescription>
        </DialogHeader>
        <FriendPicker picked={picked} onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} max={MAX_OTHERS} />
        {picked.length > 0 && (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={picked.length > 1 ? "Group name (optional)" : "Name it to make a group"}
            aria-label="Group name"
            maxLength={100}
          />
        )}
        <Button disabled={!picked.length || busy} onClick={() => void start()}>
          {picked.length > 1 || name.trim() ? "Create Group DM" : "Create DM"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
