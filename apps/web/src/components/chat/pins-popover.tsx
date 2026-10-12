import type { Message } from "@app/protocol";
import { useQuery } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { useState } from "react";

import { FoundMessages } from "@/components/chat/found-messages";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInstance } from "@/lib/instances";
import { cn } from "@/lib/utils";

/** The channel's pinned messages, newest pin first. */
export function PinsPopover({ guildId, channelId }: { guildId: string; channelId: string }) {
  const inst = useInstance();
  const [open, setOpen] = useState(false);
  const pins = useQuery({
    queryKey: ["pins", inst.id, channelId],
    queryFn: () => inst.api<Message[]>("GET", `/channels/${channelId}/pins`),
    enabled: open,
    staleTime: 0,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button aria-label="Pinned Messages" title="Pinned Messages" className={cn("text-muted-foreground hover:text-foreground", open && "text-foreground")}>
          <Pin className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-96 overflow-y-auto p-3" data-testid="pins">
        <div className="mb-2 font-semibold">Pinned Messages</div>
        {pins.data?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">This channel doesn't have any pinned messages yet.</p>}
        <FoundMessages guildId={guildId} messages={pins.data ?? []} onOpen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
