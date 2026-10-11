import type { Emote } from "@app/protocol";
import { CornerUpLeft, Pencil, RotateCw, SmilePlus, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";

import { Attachments } from "@/components/chat/attachments";
import { EmojiPicker } from "@/components/chat/emoji-picker";
import { EmoteImage, Markup } from "@/components/chat/markup";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar, userColor } from "@/components/user-avatar";
import { api } from "@/lib/api";
import { snowflakeTime } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { type UiMessage, useMessages } from "@/stores/messages";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

function formatTime(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today at ${timeFmt.format(d)}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

function msgTime(m: UiMessage) {
  return m.pending || m.failed ? Date.now() : snowflakeTime(m.id);
}

export function shouldGroup(prev: UiMessage | undefined, m: UiMessage) {
  return !!prev && prev.author.id === m.author.id && !m.replyTo && msgTime(m) - msgTime(prev) < 7 * 60_000;
}

function reactionPath(m: UiMessage, emoji: string) {
  return `/channels/${m.channelId}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
}

export const MessageItem = memo(function MessageItem({
  message: m,
  grouped,
  guildId,
  emotes,
  emoteById,
  canManage,
  isMine,
  onReply,
  editing,
  setEditing,
}: {
  message: UiMessage;
  grouped: boolean;
  guildId: string;
  emotes: Map<string, Emote>;
  emoteById: Map<string, Emote>;
  canManage: boolean;
  isMine: boolean;
  onReply: (m: UiMessage) => void;
  editing: boolean;
  setEditing: (id: string | null) => void;
}) {
  const nick = useApp((s) => s.members[guildId]?.[m.author.id]?.nick);
  const reply = useMessages((s) => (m.replyTo ? s.channels[m.channelId]?.items.find((x) => x.id === m.replyTo) : undefined));
  const replyNick = useApp((s) => (reply ? s.members[guildId]?.[reply.author.id]?.nick : undefined));
  const [pickerOpen, setPickerOpen] = useState(false);
  const real = !m.pending && !m.failed;

  const toggleReaction = async (emoji: string, me: boolean) => {
    try {
      await api(me ? "DELETE" : "PUT", reactionPath(m, emoji));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      await api("DELETE", `/channels/${m.channelId}/messages/${m.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className={cn("group relative px-4 hover:bg-black/[0.06]", grouped ? "py-0.5" : "mt-4 pt-0.5 pb-0.5", pickerOpen && "bg-black/[0.06]")}>
      {m.replyTo && (
        <div className="mb-1 ml-14 flex items-center gap-1 text-xs text-muted-foreground before:-mb-2 before:ml-[-36px] before:h-2.5 before:w-8 before:rounded-tl-md before:border-t-2 before:border-l-2 before:border-muted-foreground/40 before:content-['']">
          {reply ? (
            <>
              <UserAvatar user={reply.author} size={16} />
              <span className="font-semibold" style={{ color: userColor(reply.author.id) }}>
                {replyNick ?? reply.author.displayName}
              </span>
              <span className="truncate opacity-80">{reply.content}</span>
            </>
          ) : (
            <span className="italic">Original message not loaded</span>
          )}
        </div>
      )}
      <div className="flex gap-4">
        <div className="w-10 shrink-0">
          {grouped ? (
            <span className="hidden pt-1 text-[10px] text-muted-foreground group-hover:block">{timeFmt.format(new Date(msgTime(m)))}</span>
          ) : (
            <UserAvatar user={m.author} size={40} className="mt-0.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="flex items-baseline gap-2">
              <span className="font-medium hover:underline" style={{ color: userColor(m.author.id) }}>
                {nick ?? m.author.displayName}
              </span>
              <span className="text-xs text-muted-foreground">{formatTime(msgTime(m))}</span>
            </div>
          )}
          {editing ? (
            <EditBox message={m} onDone={() => setEditing(null)} />
          ) : (
            <div className={cn("selectable leading-[1.375rem] break-words whitespace-pre-wrap", m.pending && "opacity-50", m.failed && "text-destructive")}>
              {m.content && <Markup content={m.content} emotes={emotes} />}
              {m.editedAt && <span className="ml-1 text-[10px] text-muted-foreground">(edited)</span>}
            </div>
          )}
          <Attachments items={m.attachments} />
          {m.failed && (
            <button className="mt-1 flex items-center gap-1 text-xs text-destructive hover:underline" onClick={() => useMessages.getState().retry(m.channelId, m.nonce!)}>
              <RotateCw className="size-3" /> Failed to send. Retry
            </button>
          )}
          {m.reactions.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.reactions.map((r) => {
                const emote = r.emoji.startsWith("e:") ? emoteById.get(r.emoji.slice(2)) : undefined;
                return (
                  <button
                    key={r.emoji}
                    onClick={() => toggleReaction(r.emoji, r.me)}
                    className={cn(
                      "flex h-6 items-center gap-1 rounded-md border px-1.5 text-sm",
                      r.me ? "border-primary bg-primary/15" : "border-transparent bg-muted hover:border-border",
                    )}
                  >
                    {emote ? <EmoteImage emote={emote} size={16} /> : r.emoji.startsWith("e:") ? "❔" : r.emoji}
                    <span className="text-xs font-semibold">{r.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {real && !editing && (
        <div className={cn("absolute -top-4 right-4 hidden rounded-md border border-border bg-card shadow-md group-hover:flex", pickerOpen && "flex")}>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button className="grid size-8 place-items-center text-muted-foreground hover:text-foreground" title="Add Reaction">
                <SmilePlus className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-2">
              <EmojiPicker
                guildId={guildId}
                onPick={({ emote, emoji }) => {
                  setPickerOpen(false);
                  const key = emote ? `e:${emote.id}` : emoji!;
                  void toggleReaction(key, !!m.reactions.find((r) => r.emoji === key)?.me);
                }}
              />
            </PopoverContent>
          </Popover>
          <button className="grid size-8 place-items-center text-muted-foreground hover:text-foreground" title="Reply" onClick={() => onReply(m)}>
            <CornerUpLeft className="size-4" />
          </button>
          {isMine && (
            <button className="grid size-8 place-items-center text-muted-foreground hover:text-foreground" title="Edit" onClick={() => setEditing(m.id)}>
              <Pencil className="size-4" />
            </button>
          )}
          {(isMine || canManage) && (
            <button className="grid size-8 place-items-center text-destructive/80 hover:text-destructive" title="Delete" onClick={remove}>
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function EditBox({ message, onDone }: { message: UiMessage; onDone: () => void }) {
  const [value, setValue] = useState(message.content);
  const save = async () => {
    const content = value.trim();
    if (!content || content === message.content) return onDone();
    try {
      await api("PATCH", `/channels/${message.channelId}/messages/${message.id}`, { content });
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="py-1">
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") onDone();
        }}
        className="min-h-0 resize-none bg-input"
      />
      <div className="mt-1 text-xs text-muted-foreground">escape to cancel • enter to save</div>
    </div>
  );
}
