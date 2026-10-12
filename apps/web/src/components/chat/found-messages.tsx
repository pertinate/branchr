import type { Emote, Message } from "@app/protocol";
import { useNavigate } from "@tanstack/react-router";
import { Hash } from "lucide-react";

import { Markup } from "@/components/chat/markup";
import { UserAvatar } from "@/components/user-avatar";
import { snowflakeTime } from "@/lib/ids";
import { useInstance } from "@/lib/instances";
import { useApp } from "@/stores/app";

const NO_EMOTES = new Map<string, Emote>();

/** Messages from search or pins: who, where, when; click to go to the channel. */
export function FoundMessages({ guildId, messages, onOpen }: { guildId: string; messages: Message[]; onOpen?: () => void }) {
  const inst = useInstance();
  const navigate = useNavigate();
  const channels = useApp((s) => s.channels);
  const members = useApp((s) => s.members[guildId]);
  return (
    <div className="space-y-1">
      {messages.map((m) => (
        <button
          key={m.id}
          data-testid="found-message"
          onClick={() => {
            onOpen?.();
            void navigate({ to: "/$instance/$guildId/$channelId", params: { instance: inst.id, guildId, channelId: m.channelId } });
          }}
          className="flex w-full gap-3 rounded-md bg-sidebar p-2 text-left hover:bg-sidebar-accent"
        >
          <UserAvatar user={m.author} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
              <span className="text-sm font-medium text-foreground">{members?.[m.author.id]?.nick ?? m.author.displayName}</span>
              <span className="flex items-center">
                <Hash className="size-3" />
                {channels[m.channelId]?.name ?? "unknown"}
              </span>
              <span>{new Date(snowflakeTime(m.id)).toLocaleString()}</span>
            </div>
            <div className="line-clamp-3 text-sm break-words">
              <Markup content={m.content} emotes={NO_EMOTES} refs={m.emotes} guildId={guildId} mentions={m.mentions} everyone={m.mentionEveryone} />
              {!m.content && m.attachments.length > 0 && <span className="text-muted-foreground italic">{m.attachments.length} attachment(s)</span>}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
