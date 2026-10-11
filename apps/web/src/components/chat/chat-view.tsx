import { Hash, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { MemberList } from "@/components/guild/member-list";
import { useInstance } from "@/lib/instances";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import type { UiMessage } from "@/stores/messages";

export function ChatView({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useApp((s) => s.channels[channelId]);
  const [showMembers, setShowMembers] = useState(true);
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [dragging, setDragging] = useState(false);
  const clearReply = useCallback(() => setReplyTo(null), []);

  // This view's instance; by cleanup time the active one may already be another.
  const inst = useInstance();
  useEffect(() => {
    setReplyTo(null);
    const app = inst.app.getState();
    app.setViewing(channelId);
    app.markRead(channelId);
    // Reads that waited while the window was hidden.
    const onVisible = () => document.visibilityState === "visible" && inst.app.getState().markRead(channelId);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (inst.app.getState().viewing === channelId) inst.app.getState().setViewing(null);
    };
  }, [inst, channelId]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4 shadow-sm">
        <Hash className="size-6 text-muted-foreground" />
        <span className="font-semibold">{channel?.name}</span>
        {channel?.topic && <span className="truncate border-l border-border pl-3 text-sm text-muted-foreground">{channel.topic}</span>}
        <div className="flex-1" />
        <button onClick={() => setShowMembers((v) => !v)} className={cn("text-muted-foreground hover:text-foreground", showMembers && "text-foreground")} title="Member List">
          <Users className="size-5" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) window.dispatchEvent(new CustomEvent("chat-files", { detail: [...e.dataTransfer.files] }));
          }}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-lg border-2 border-dashed border-primary bg-primary/10 text-lg font-semibold">
              Drop files to upload to #{channel?.name}
            </div>
          )}
          <MessageList channelId={channelId} guildId={guildId} onReply={setReplyTo} />
          <Composer channelId={channelId} guildId={guildId} replyTo={replyTo} clearReply={clearReply} />
        </div>
        {showMembers && <MemberList guildId={guildId} />}
      </div>
    </div>
  );
}
