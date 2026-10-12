import { Hash, Search, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { PinsPopover } from "@/components/chat/pins-popover";
import { SearchPanel } from "@/components/chat/search-panel";
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
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState<string | null>(null);
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
        <PinsPopover guildId={guildId} channelId={channelId} />
        <button onClick={() => setShowMembers((v) => !v)} className={cn("text-muted-foreground hover:text-foreground", showMembers && "text-foreground")} title="Member List">
          <Users className="size-5" />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(draft.trim() || null);
          }}
          className="relative ml-1"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setDraft(""), setSearch(null))}
            placeholder="Search"
            aria-label="Search messages"
            className="h-7 w-40 rounded bg-sidebar px-2 pr-7 text-sm outline-none transition-all placeholder:text-muted-foreground focus:w-60"
          />
          <Search className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground" />
        </form>
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
        {search ? (
          <SearchPanel key={search} guildId={guildId} query={search} onClose={() => (setSearch(null), setDraft(""))} />
        ) : (
          showMembers && <MemberList guildId={guildId} />
        )}
      </div>
    </div>
  );
}
