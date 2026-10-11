import { Hash, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { MemberList } from "@/components/guild/member-list";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import type { UiMessage } from "@/stores/messages";

export function ChatView({ guildId, channelId }: { guildId: string; channelId: string }) {
  const channel = useApp((s) => s.channels[channelId]);
  const [showMembers, setShowMembers] = useState(true);
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const clearReply = useCallback(() => setReplyTo(null), []);

  useEffect(() => {
    setReplyTo(null);
    useApp.getState().markRead(channelId);
  }, [channelId]);

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
        <div className="flex min-w-0 flex-1 flex-col">
          <MessageList channelId={channelId} guildId={guildId} onReply={setReplyTo} />
          <Composer channelId={channelId} guildId={guildId} replyTo={replyTo} clearReply={clearReply} />
        </div>
        {showMembers && <MemberList guildId={guildId} />}
      </div>
    </div>
  );
}
