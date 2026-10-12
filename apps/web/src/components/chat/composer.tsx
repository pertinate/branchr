import type { Attachment, Emote, Role, User } from "@app/protocol";
import { FileIcon, Paperclip, Smile, Timer, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { EmojiPicker } from "@/components/chat/emoji-picker";
import { EmoteImage } from "@/components/chat/markup";
import { UserAvatar } from "@/components/user-avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { gateway } from "@/lib/gateway";
import { formatBytes, uploadAttachment } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { emoteToken } from "@/lib/emotes";
import { canMentionEveryone } from "@/lib/mentions";
import { P, roleColor, useChannelCan } from "@/lib/perms";
import { useApp } from "@/stores/app";
import { useEmoteGroups } from "@/stores/emotes";
import { type UiMessage, useMessages } from "@/stores/messages";

/** When each slowed channel lets us send again (this session; the server has the final say). */
const slowmodeUntil = new Map<string, number>();

/** Seconds left before we can send in `channelId` again, ticking down. */
function useSlowmodeWait(channelId: string) {
  const left = () => Math.max(0, Math.ceil(((slowmodeUntil.get(channelId) ?? 0) - Date.now()) / 1000));
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    const tick = () => setSecs(left());
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);
  return secs;
}

const TYPING_INTERVAL = 6000;

type Mentionable =
  | { kind: "user"; user: User; name: string }
  | { kind: "role"; role: Role; name: string }
  | { kind: "everyone"; name: "everyone" | "here"; hint: string };
const EVERYONE: Mentionable[] = [
  { kind: "everyone", name: "here", hint: "Notifies everyone online" },
  { kind: "everyone", name: "everyone", hint: "Notifies everyone in this leaflet" },
];
type Suggestion =
  | { kind: "emote"; start: number; end: number; matches: Emote[] }
  | { kind: "mention"; start: number; end: number; matches: Mentionable[] };

interface Upload {
  key: string;
  file: File;
  preview: string | null;
  progress: number;
  attachment?: Attachment;
  error?: string;
  abort: AbortController;
}
const drafts = new Map<string, string>();

export function Composer({ channelId, guildId, replyTo, clearReply }: { channelId: string; guildId: string; replyTo: UiMessage | null; clearReply: () => void }) {
  const channelName = useApp((s) => s.channels[channelId]?.name);
  const canSend = useChannelCan(channelId, P.SEND_MESSAGES);
  const canAttach = useChannelCan(channelId, P.ATTACH_FILES);
  // A thread goes at its channel's pace.
  const slowmode = useApp((s) => {
    const c = s.channels[channelId];
    return (c?.kind === "thread" && c.parentId ? s.channels[c.parentId]?.slowmodeSecs : c?.slowmodeSecs) ?? 0;
  });
  const manageMessages = useChannelCan(channelId, P.MANAGE_MESSAGES);
  const manageChannel = useChannelCan(channelId, P.MANAGE_CHANNELS);
  const exempt = manageMessages || manageChannel;
  const held = slowmode > 0 && !exempt;
  const wait = useSlowmodeWait(channelId);
  const groups = useEmoteGroups(guildId);
  const members = useApp((s) => s.members[guildId]);
  const roles = useApp((s) => s.roles[guildId]);
  const guildNames = useMemo(() => new Map(groups.map((g) => [g.guild.id, g.guild.name])), [groups]);
  const [value, setValue] = useState(() => drafts.get(channelId) ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | File[]) => {
    if (!canAttach) {
      toast.error("You can't upload files in this channel");
      return;
    }
    const added: Upload[] = [...files].slice(0, 10 - uploads.length).map((file) => ({
      key: `${file.name}-${file.size}-${Math.random()}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      progress: 0,
      abort: new AbortController(),
    }));
    setUploads((u) => [...u, ...added]);
    for (const up of added) {
      uploadAttachment(channelId, up.file, (p) => setUploads((u) => u.map((x) => (x.key === up.key ? { ...x, progress: p } : x))), up.abort.signal)
        .then((attachment) => setUploads((u) => u.map((x) => (x.key === up.key ? { ...x, attachment, progress: 1 } : x))))
        .catch((e: Error) => {
          if (up.abort.signal.aborted) return;
          const error = e.message || "upload failed";
          toast.error(`Couldn't upload ${up.file.name}`, { description: error });
          setUploads((u) => u.map((x) => (x.key === up.key ? { ...x, error } : x)));
        });
    }
  };

  const removeUpload = (key: string) =>
    setUploads((u) => {
      const up = u.find((x) => x.key === key);
      up?.abort.abort();
      if (up?.preview) URL.revokeObjectURL(up.preview);
      return u.filter((x) => x.key !== key);
    });

  // Text from menus elsewhere ("Mention"), typed at the caret.
  useEffect(() => {
    const onInsert = (e: Event) => insert((e as CustomEvent<string>).detail.trimEnd());
    window.addEventListener("composer-insert", onInsert);
    return () => window.removeEventListener("composer-insert", onInsert);
  });

  // Files dropped anywhere on the chat view land here.
  useEffect(() => {
    const onDrop = (e: Event) => addFiles((e as CustomEvent<File[]>).detail);
    window.addEventListener("chat-files", onDrop);
    return () => window.removeEventListener("chat-files", onDrop);
  });
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const replyNick = useApp((s) => (replyTo ? (s.members[guildId]?.[replyTo.author.id]?.nick ?? replyTo.author.displayName) : null));

  useEffect(() => {
    setValue(drafts.get(channelId) ?? "");
    ta.current?.focus();
  }, [channelId]);
  useEffect(() => {
    drafts.set(channelId, value);
  }, [channelId, value]);
  useEffect(() => {
    if (replyTo) ta.current?.focus();
  }, [replyTo]);

  // Caret after an insert, placed before paint so fast typing lands after the insert.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || !ta.current) return;
    ta.current.setSelectionRange(caret.current, caret.current);
    ta.current.focus();
    caret.current = null;
  }, [value]);

  // Autosize.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, [value]);

  // `:par` -> emotes and `@al` -> people, for the word under the caret.
  const suggestion = useMemo((): Suggestion | null => {
    const caret = ta.current?.selectionStart ?? value.length;
    const at = /(?:^|\s)@([\w.]{0,32})$/.exec(value.slice(0, caret));
    if (at && !/^[\w.]/.test(value.slice(caret))) {
      const q = at[1].toLowerCase();
      const people: Mentionable[] = Object.values(members ?? {}).map((m) => ({ kind: "user", user: m.user, name: m.nick ?? m.user.displayName }));
      const score = (x: Mentionable) => {
        const names = x.kind === "user" ? [x.user.username, x.name] : [x.name];
        if (names.some((n) => n.toLowerCase().startsWith(q))) return 0;
        return names.some((n) => n.toLowerCase().includes(q)) ? 1 : -1;
      };
      // Roles that would ping: mentionable ones, or all with Mention @everyone.
      const all = canMentionEveryone(guildId);
      const pingable: Mentionable[] = (roles ?? [])
        .filter((r) => r.id !== guildId && (r.mentionable || all))
        .map((r) => ({ kind: "role", role: r, name: r.name }));
      const matches = [...people.sort((a, b) => a.name.localeCompare(b.name)), ...pingable, ...(all ? EVERYONE : [])]
        .map((x) => [x, score(x)] as const)
        .filter(([, s]) => s >= 0)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 8)
        .map(([x]) => x);
      return matches.length ? { kind: "mention", start: caret - at[1].length - 1, end: caret, matches } : null;
    }
    const m = /(?:^|\s):([\w!?-]{2,})$/.exec(value.slice(0, caret));
    // Not inside an already-closed :name: (e.g. right after picking a suggestion).
    if (!m || /^[\w!?-]*:/.test(value.slice(caret))) return null;
    const q = m[1].toLowerCase();
    // This server's emotes rank first, then prefix matches, then shorter names.
    const rank = (e: Emote) => (e.guildId === guildId ? 0 : 2) + Number(!e.name.toLowerCase().startsWith(q));
    const matches = groups
      .flatMap((g) => g.emotes.filter((e) => e.name.toLowerCase().includes(q)))
      .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
      .slice(0, 8);
    return matches.length ? { kind: "emote", start: caret - m[1].length - 1, end: caret, matches } : null;
  }, [value, groups, guildId, members, roles]);

  useEffect(() => setSel(0), [suggestion?.matches.length]);

  const insertEmote = (e: Emote, range?: { start: number; end: number }) =>
    // This server's emotes by :name:; other servers' need an explicit reference.
    insert(e.guildId === guildId ? `:${e.name}:` : emoteToken(e), range);

  // People by @username (the server turns it into a mention); unique, unlike display names.
  const insertMention = (x: Mentionable, range: { start: number; end: number }) =>
    insert(`@${x.kind === "user" ? x.user.username : x.name}`, range);

  const pick = (s: Suggestion, i: number) => (s.kind === "emote" ? insertEmote(s.matches[i], s) : insertMention(s.matches[i], s));

  const insert = (text: string, range?: { start: number; end: number }) => {
    const el = ta.current;
    const start = range?.start ?? el?.selectionStart ?? value.length;
    const end = range?.end ?? el?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${text} ${value.slice(end)}`;
    setValue(next);
    caret.current = before.length + pad.length + text.length + 1;
  };

  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const send = () => {
    const content = value.trim();
    const ready = uploads.filter((u) => u.attachment).map((u) => u.attachment!);
    if ((!content && !ready.length) || uploading || (held && wait > 0)) return;
    if (held) slowmodeUntil.set(channelId, Date.now() + slowmode * 1000);
    setValue("");
    clearReply();
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview);
    setUploads([]);
    void useMessages.getState().send(channelId, content, replyTo?.id ?? null, ready);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestion) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + suggestion.matches.length) % suggestion.matches.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        pick(suggestion, sel);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && replyTo) {
      clearReply();
    } else if (e.key === "ArrowUp" && !value) {
      e.preventDefault();
      window.dispatchEvent(new Event("edit-last-message"));
    }
  };

  const onChange = (v: string) => {
    setValue(v);
    const now = Date.now();
    if (v && now - lastTyping.current > TYPING_INTERVAL) {
      lastTyping.current = now;
      gateway.send({ op: "typing", d: { channelId } });
    }
  };

  if (!canSend) {
    return (
      <div className="px-4">
        <div className="rounded-lg bg-[oklch(0.335_0.009_264)] px-4 py-3 text-muted-foreground" data-testid="composer-locked">
          You don't have permission to send messages in this channel.
        </div>
      </div>
    );
  }

  return (
    <div className="relative px-4">
      {held && (
        <div data-testid="slowmode" className="absolute -top-5 right-6 flex items-center gap-1 text-xs text-muted-foreground" title={`Slow mode: one message every ${slowmode}s`}>
          <Timer className="size-3.5" /> {wait > 0 ? `${wait}s` : "Slow mode"}
        </div>
      )}
      {suggestion?.kind === "mention" && (
        <div className="absolute right-4 bottom-full left-4 mb-1 rounded-md border border-border bg-popover p-1 shadow-lg">
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase">Members</div>
          {suggestion.matches.map((x, i) => (
            <button
              key={x.kind === "user" ? x.user.id : x.kind === "role" ? x.role.id : x.name}
              onMouseDown={(ev) => {
                ev.preventDefault();
                pick(suggestion, i);
              }}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left", i === sel && "bg-accent")}
            >
              {x.kind === "user" ? (
                <>
                  <UserAvatar user={x.user} size={24} />
                  <span>{x.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">{x.user.username}</span>
                </>
              ) : x.kind === "role" ? (
                <>
                  <span className="grid size-6 place-items-center font-semibold" style={{ color: roleColor(x.role) }}>
                    @
                  </span>
                  <span style={{ color: roleColor(x.role) }}>@{x.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">Notifies members with this role</span>
                </>
              ) : (
                <>
                  <span className="grid size-6 place-items-center font-semibold text-muted-foreground">@</span>
                  <span>@{x.name}</span>
                  <span className="ml-auto truncate text-xs text-muted-foreground">{x.hint}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {suggestion?.kind === "emote" && (
        <div className="absolute right-4 bottom-full left-4 mb-1 rounded-md border border-border bg-popover p-1 shadow-lg">
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase">Emotes matching :{value.slice(suggestion.start + 1, suggestion.end)}</div>
          {suggestion.matches.map((e, i) => (
            <button
              key={e.id}
              onMouseDown={(ev) => {
                ev.preventDefault();
                insertEmote(e, suggestion);
              }}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left", i === sel && "bg-accent")}
            >
              <EmoteImage emote={e} size={24} />
              <span>{e.name}</span>
              {e.guildId !== guildId && <span className="ml-auto truncate text-xs text-muted-foreground">{guildNames.get(e.guildId)}</span>}
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div className="flex items-center justify-between rounded-t-lg bg-muted px-4 py-2 text-sm text-muted-foreground">
          <span>
            Replying to <span className="font-semibold text-foreground">{replyNick}</span>
          </span>
          <button onClick={clearReply}>
            <X className="size-4" />
          </button>
        </div>
      )}
      {uploads.length > 0 && (
        <div className={cn("flex gap-2 overflow-x-auto bg-[oklch(0.335_0.009_264)] p-3", !replyTo && "rounded-t-lg")}>
          {uploads.map((u) => (
            <ContextMenu key={u.key}>
            <ContextMenuTrigger asChild>
            <div data-upload={u.error ? "error" : u.attachment ? "done" : "uploading"} className="relative w-40 shrink-0 rounded-md bg-muted p-2">
              <button className="absolute top-1 right-1 rounded bg-black/60 p-0.5" onClick={() => removeUpload(u.key)} aria-label={`Remove ${u.file.name}`}>
                <X className="size-3.5" />
              </button>
              {u.preview ? (
                <img src={u.preview} alt="" className="h-24 w-full rounded object-cover" />
              ) : (
                <div className="grid h-24 place-items-center"><FileIcon className="size-10 text-muted-foreground" /></div>
              )}
              <div className="mt-1 truncate text-xs">{u.file.name}</div>
              {u.error ? (
                <div className="text-xs text-destructive">{u.error}</div>
              ) : (
                <div className="mt-1 h-1 overflow-hidden rounded bg-background">
                  <div className={cn("h-full", u.attachment ? "bg-online" : "bg-primary")} style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </div>
              )}
              <div className="text-[10px] text-muted-foreground">{formatBytes(u.file.size)}</div>
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem variant="destructive" onSelect={() => removeUpload(u.key)}>
                Remove Attachment
              </ContextMenuItem>
            </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
      <div className={cn("flex items-end gap-2 bg-[oklch(0.335_0.009_264)] px-4", replyTo || uploads.length ? "rounded-b-lg" : "rounded-lg")}>
        {canAttach && (
          <button className="py-3 text-muted-foreground hover:text-foreground" onClick={() => fileInput.current?.click()} aria-label="Upload a file">
            <Paperclip className="size-6" />
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          ref={ta}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          placeholder={`Message #${channelName ?? ""}`}
          maxLength={4000}
          className="selectable max-h-[400px] flex-1 resize-none bg-transparent py-3 outline-none placeholder:text-muted-foreground"
        />
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button className="py-3 text-muted-foreground hover:text-foreground">
              <Smile className="size-6" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-auto p-2">
            <EmojiPicker
              guildId={guildId}
              onPick={({ emote, emoji }) => {
                setPickerOpen(false);
                if (emote) insertEmote(emote);
                else setValue((v) => v + emoji);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      <TypingIndicator channelId={channelId} guildId={guildId} />
    </div>
  );
}

function TypingIndicator({ channelId, guildId }: { channelId: string; guildId: string }) {
  const names = useApp(
    useShallow((s) => Object.keys(s.typing[channelId] ?? {}).map((u) => s.members[guildId]?.[u]?.nick ?? s.members[guildId]?.[u]?.user.displayName ?? "Someone")),
  );
  return (
    <div className="h-6 truncate text-xs leading-6 text-muted-foreground">
      {names.length > 0 && (
        <>
          <span className="mr-1 inline-flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="inline-block size-1 animate-bounce rounded-full bg-foreground" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </span>
          <span className="font-semibold text-foreground">{names.length > 3 ? "Several people" : names.join(", ")}</span>{" "}
          {names.length === 1 ? "is" : "are"} typing…
        </>
      )}
    </div>
  );
}
