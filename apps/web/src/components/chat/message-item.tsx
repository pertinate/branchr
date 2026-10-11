import type { Emote } from "@app/protocol";
import { Copy, CornerUpLeft, Download, ExternalLink, Image as ImageIcon, Link2, Pencil, RotateCw, SmilePlus, Sparkles, Trash2 } from "lucide-react";
import { memo, useRef, useState } from "react";
import { toast } from "sonner";

import { Attachments } from "@/components/chat/attachments";
import { EmojiPicker } from "@/components/chat/emoji-picker";
import { EmoteImage, Markup } from "@/components/chat/markup";
import { Menu, UserMenuItems } from "@/components/menus";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar, userColor } from "@/components/user-avatar";
import { copy, copyImage, saveFile } from "@/lib/actions";
import { api } from "@/lib/api";
import { emotePage, providerNames } from "@/lib/emotes";
import { snowflakeTime } from "@/lib/ids";
import { editableMentions, mentionsMe, plainText } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useEmote, useEmoteCard } from "@/stores/emotes";
import { type UiMessage, useMessages } from "@/stores/messages";
import { usePrefs } from "@/stores/ui";

/** Quick reactions at the top of a message's menu. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥"];

/** What was under the pointer when the message's menu opened. */
interface MenuTarget {
  link?: string;
  image?: { url: string; name: string };
  emote?: { emote: Emote; el: HTMLElement };
}

function menuTarget(el: HTMLElement, emotes: (id: string) => Emote | undefined): MenuTarget {
  const t: MenuTarget = {};
  const media = el.closest<HTMLElement>("[data-attachment-url]");
  if (media && !media.hasAttribute("data-attachment-video")) t.image = { url: media.dataset.attachmentUrl!, name: media.dataset.attachmentName! };
  const a = el.closest<HTMLAnchorElement>("a[href]");
  if (a && /^https?:/.test(a.href)) t.link = a.href;
  const em = el.closest<HTMLElement>("[data-emote-id]");
  const emote = em && emotes(em.dataset.emoteId!);
  if (em && emote) t.emote = { emote, el: em };
  return t;
}

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
  const devMode = usePrefs((s) => s.devMode);
  const [target, setTarget] = useState<MenuTarget>({});
  // "Add Reaction" from the menu opens the picker once the menu is gone (see onCloseAutoFocus).
  const pickerAfterMenu = useRef(false);
  const pinged = useApp((s) => mentionsMe(m, s.me?.id));

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

  const react = (emoji: string) => void toggleReaction(emoji, !!m.reactions.find((r) => r.emoji === emoji)?.me);
  const items = (
    <>
      {target.link && (
        <>
          <ContextMenuItem onSelect={() => window.open(target.link, "_blank", "noopener")}>
            Open Link <ExternalLink className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy(target.link!, "Copied link")}>
            Copy Link <Link2 className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {target.image && (
        <>
          <ContextMenuItem onSelect={() => window.open(target.image!.url, "_blank", "noopener")}>
            Open Original <ExternalLink className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyImage(target.image!.url)}>
            Copy Image <ImageIcon className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void saveFile(target.image!.url, target.image!.name)}>
            Save Image <Download className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy(target.image!.url, "Copied link")}>
            Copy Image Link <Link2 className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {target.emote && (
        <>
          <ContextMenuItem onSelect={() => useEmoteCard.getState().open(target.emote!.emote, target.emote!.el)}>
            About :{target.emote.emote.name}: <Sparkles className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copy(target.emote!.emote.name, "Copied emote name")}>
            Copy Emote Name <Copy className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => window.open(emotePage(target.emote!.emote), "_blank", "noopener")}>
            Open on {providerNames[target.emote.emote.provider]} <ExternalLink className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {real && (
        <>
          <div className="flex gap-1 px-1 pb-1">
            {QUICK_REACTIONS.map((e) => (
              <ContextMenuItem key={e} aria-label={`React ${e}`} className="size-9 justify-center rounded-full bg-muted text-xl" onSelect={() => react(e)}>
                {e}
              </ContextMenuItem>
            ))}
          </div>
          <ContextMenuItem onSelect={() => (pickerAfterMenu.current = true)}>
            Add Reaction <SmilePlus className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onReply(m)}>
            Reply <CornerUpLeft className="ml-auto" />
          </ContextMenuItem>
          {isMine && (
            <ContextMenuItem onSelect={() => setEditing(m.id)}>
              Edit Message <Pencil className="ml-auto" />
            </ContextMenuItem>
          )}
        </>
      )}
      {m.content && (
        <ContextMenuItem onSelect={() => void copy(plainText(m, guildId), "Copied text")}>
          Copy Text <Copy className="ml-auto" />
        </ContextMenuItem>
      )}
      {real && (isMine || canManage) && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => void remove()}>
            Delete Message <Trash2 className="ml-auto" />
          </ContextMenuItem>
        </>
      )}
      {real && devMode && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => void copy(m.id, "Copied message ID")}>
            Copy Message ID <Copy className="ml-auto" />
          </ContextMenuItem>
        </>
      )}
    </>
  );

  return (
    <ContextMenu>
    <ContextMenuTrigger asChild>
    <div
      onContextMenu={(e) => setTarget(menuTarget(e.target as HTMLElement, (id) => emoteById.get(id) ?? m.emotes.find((x) => x.id === id)))}
      data-pinged={pinged || undefined}
      className={cn(
        "group relative px-4",
        grouped ? "py-0.5" : "mt-4 pt-0.5 pb-0.5",
        pinged
          ? "bg-amber-400/10 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-amber-400 before:content-[''] hover:bg-amber-400/[0.14]"
          : cn("hover:bg-black/[0.06]", pickerOpen && "bg-black/[0.06]"),
      )}
    >
      {m.replyTo && (
        <div className="mb-1 ml-14 flex items-center gap-1 text-xs text-muted-foreground before:-mb-2 before:ml-[-36px] before:h-2.5 before:w-8 before:rounded-tl-md before:border-t-2 before:border-l-2 before:border-muted-foreground/40 before:content-['']">
          {reply ? (
            <>
              <UserAvatar user={reply.author} size={16} />
              <span className="font-semibold" style={{ color: userColor(reply.author.id) }}>
                {replyNick ?? reply.author.displayName}
              </span>
              <span className="truncate opacity-80">{plainText(reply, guildId)}</span>
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
            <Menu items={<UserMenuItems guildId={guildId} userId={m.author.id} />}>
              <span className="block cursor-pointer">
                <UserAvatar user={m.author} size={40} className="mt-0.5" />
              </span>
            </Menu>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {!grouped && (
            <div className="flex items-baseline gap-2">
              <Menu items={<UserMenuItems guildId={guildId} userId={m.author.id} />}>
                <span className="cursor-pointer font-medium hover:underline" style={{ color: userColor(m.author.id) }}>
                  {nick ?? m.author.displayName}
                </span>
              </Menu>
              <span className="text-xs text-muted-foreground">{formatTime(msgTime(m))}</span>
            </div>
          )}
          {editing ? (
            <EditBox message={m} onDone={() => setEditing(null)} />
          ) : (
            <div className={cn("selectable leading-[1.375rem] break-words whitespace-pre-wrap", m.pending && "opacity-50", m.failed && "text-destructive")}>
              {m.content && <Markup content={m.content} emotes={emotes} refs={m.emotes} guildId={guildId} mentions={m.mentions} everyone={m.mentionEveryone} />}
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
                return (
                  <button
                    key={r.emoji}
                    onClick={() => toggleReaction(r.emoji, r.me)}
                    className={cn(
                      "flex h-6 items-center gap-1 rounded-md border px-1.5 text-sm",
                      r.me ? "border-primary bg-primary/15" : "border-transparent bg-muted hover:border-border",
                    )}
                  >
                    {r.emoji.startsWith("e:") ? <ReactionEmote id={r.emoji.slice(2)} known={emoteById} /> : r.emoji}
                    <span className="text-xs font-semibold">{r.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {real && !editing && (
        <div
          className={cn(
            "pointer-events-none absolute -top-4 right-4 flex rounded-md border border-border bg-card opacity-0 shadow-md group-hover:pointer-events-auto group-hover:opacity-100",
            pickerOpen && "pointer-events-auto opacity-100",
          )}
        >
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
    </ContextMenuTrigger>
    <ContextMenuContent
      className="w-56"
      onCloseAutoFocus={(e) => {
        if (!pickerAfterMenu.current) return;
        // Focus going back to the message would count as "outside" and close the picker.
        e.preventDefault();
        pickerAfterMenu.current = false;
        setPickerOpen(true);
      }}
    >
      {items}
    </ContextMenuContent>
    </ContextMenu>
  );
});

function EditBox({ message, onDone }: { message: UiMessage; onDone: () => void }) {
  // Mentions are edited as they're typed (@username); the server resolves them again.
  const [initial] = useState(() => editableMentions(message.content, message.mentions));
  const [value, setValue] = useState(initial);
  const save = async () => {
    const content = value.trim();
    if (!content || content === initial) return onDone();
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

/** A reaction's emote, which may be from a server the viewer isn't in. */
function ReactionEmote({ id, known }: { id: string; known: Map<string, Emote> }) {
  const emote = useEmote(id, known);
  return emote ? <EmoteImage emote={emote} size={16} /> : <>❔</>;
}
