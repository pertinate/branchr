import type { Emote } from "@app/protocol";
import { Smile, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { EmojiPicker } from "@/components/chat/emoji-picker";
import { EmoteImage } from "@/components/chat/markup";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { gateway } from "@/lib/gateway";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { type UiMessage, useMessages } from "@/stores/messages";

const TYPING_INTERVAL = 6000;
const drafts = new Map<string, string>();

export function Composer({ channelId, guildId, replyTo, clearReply }: { channelId: string; guildId: string; replyTo: UiMessage | null; clearReply: () => void }) {
  const channelName = useApp((s) => s.channels[channelId]?.name);
  const emotes = useApp(useShallow((s) => s.emotes[guildId] ?? []));
  const [value, setValue] = useState(() => drafts.get(channelId) ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sel, setSel] = useState(0);
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

  // Autosize.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, [value]);

  // `:par` -> suggestions for the word under the caret.
  const suggestion = useMemo(() => {
    const caret = ta.current?.selectionStart ?? value.length;
    const m = /(?:^|\s):([\w!?-]{2,})$/.exec(value.slice(0, caret));
    if (!m) return null;
    const q = m[1].toLowerCase();
    const matches = emotes.filter((e) => e.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.length - b.name.length).slice(0, 8);
    return matches.length ? { start: caret - m[1].length - 1, end: caret, matches } : null;
  }, [value, emotes]);

  useEffect(() => setSel(0), [suggestion?.matches.length]);

  const insertEmote = (e: Emote, range?: { start: number; end: number }) => {
    const el = ta.current;
    const start = range?.start ?? el?.selectionStart ?? value.length;
    const end = range?.end ?? el?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${pad}${e.name} ${value.slice(end)}`;
    setValue(next);
    requestAnimationFrame(() => {
      const pos = before.length + pad.length + e.name.length + 1;
      el?.setSelectionRange(pos, pos);
      el?.focus();
    });
  };

  const send = () => {
    const content = value.trim();
    if (!content) return;
    setValue("");
    clearReply();
    void useMessages.getState().send(channelId, content, replyTo?.id ?? null);
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
        insertEmote(suggestion.matches[sel], suggestion);
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

  return (
    <div className="relative px-4">
      {suggestion && (
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
      <div className={cn("flex items-end gap-2 bg-[oklch(0.335_0.009_264)] px-4", replyTo ? "rounded-b-lg" : "rounded-lg")}>
        <textarea
          ref={ta}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
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
