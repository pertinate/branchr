import type { Emote } from "@app/protocol";
import { AtSign, Pencil, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Markup } from "@/components/chat/markup";
import { PersonAvatar, asUser } from "@/components/home/person-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { snowflakeTime } from "@/lib/ids";
import { type UiDm, ack, deleteDm, editDm, loadThread, sendDm, setViewing, typing, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";

const NO_EMOTES = new Map<string, Emote>();
const time = (m: UiDm) => (m.pending || m.failed ? Date.now() : snowflakeTime(m.id));

/** One direct message conversation. */
export function DmView({ channelId }: { channelId: string }) {
  const channel = useSocial((s) => s.channels[channelId]);
  const thread = useSocial((s) => s.threads[channelId]);
  const me = useSocial((s) => s.me);
  const typers = useSocial(useShallow((s) => Object.keys(s.typing[channelId] ?? {})));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const other = channel?.recipients[0];

  useEffect(() => {
    setViewing(channelId);
    void loadThread(channelId).catch((e: Error) => toast.error(e.message));
    const onVisible = () => document.visibilityState === "visible" && ack(channelId);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      setViewing(null);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [channelId]);
  useEffect(() => ack(channelId), [channelId, channel?.lastMessageId]);
  // Stay at the bottom as messages arrive, unless reading further up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread?.items.length]);

  if (!channel || !other) return <p className="m-auto text-muted-foreground">This conversation doesn't exist.</p>;
  const items = thread?.items ?? [];
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/20 px-4 shadow-sm">
        <AtSign className="size-5 text-muted-foreground" />
        <span className="font-semibold">{other.displayName}</span>
        <span className="text-sm text-muted-foreground">@{other.handle}</span>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto pb-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (el.scrollTop < 200 && thread?.hasMore && thread.loaded) void loadThread(channelId, true);
        }}
      >
        {thread?.loaded && !thread.hasMore && (
          <div className="px-4 pt-8 pb-4">
            <PersonAvatar person={other} size={80} />
            <h1 className="mt-2 text-3xl font-bold">{other.displayName}</h1>
            <p className="text-muted-foreground">This is the beginning of your direct messages with {other.displayName}.</p>
          </div>
        )}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const grouped = !!prev && prev.author.id === m.author.id && time(m) - time(prev) < 7 * 60_000;
          return <DmItem key={m.nonce ?? m.id} m={m} grouped={grouped} mine={m.author.id === me?.id} />;
        })}
      </div>
      <DmComposer channelId={channelId} name={other.displayName} />
      <div className="h-6 px-4 text-xs text-muted-foreground">{typers.length > 0 && `${other.displayName} is typing…`}</div>
    </>
  );
}

function DmItem({ m, grouped, mine }: { m: UiDm; grouped: boolean; mine: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(m.content);
  const real = !m.pending && !m.failed;
  const save = async () => {
    setEditing(false);
    if (!value.trim() || value.trim() === m.content) return;
    try {
      await editDm(m.channelId, m.id, value.trim());
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm("Delete this message?")) return;
    try {
      await deleteDm(m.channelId, m.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className={cn("group relative flex gap-4 px-4 hover:bg-black/5", grouped ? "py-0.5" : "mt-3 pt-0.5", m.pending && "opacity-60")} data-testid="dm-message">
      <div className="w-10 shrink-0">{!grouped && <UserAvatar user={asUser(m.author)} size={40} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{m.author.displayName}</span>
            <time className="text-xs text-muted-foreground">{new Date(time(m)).toLocaleString()}</time>
          </div>
        )}
        {editing ? (
          <textarea
            autoFocus
            value={value}
            aria-label="Edit message"
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                setValue(m.content);
                setEditing(false);
              }
            }}
            className="w-full resize-none rounded bg-[oklch(0.335_0.009_264)] p-2 outline-none"
          />
        ) : (
          <div className="selectable break-words whitespace-pre-wrap">
            <Markup content={m.content} emotes={NO_EMOTES} />
            {m.editedAt && <span className="ml-1 text-[10px] text-muted-foreground">(edited)</span>}
            {m.failed && <span className="ml-2 text-xs text-destructive">Couldn't send</span>}
          </div>
        )}
      </div>
      {mine && real && !editing && (
        <div className="absolute -top-3 right-4 hidden rounded-md border border-border bg-popover shadow group-hover:flex">
          <button aria-label="Edit" onClick={() => setEditing(true)} className="p-1.5 hover:bg-accent">
            <Pencil className="size-4" />
          </button>
          <button aria-label="Delete" onClick={() => void remove()} className="p-1.5 text-destructive hover:bg-accent">
            <Trash2 className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function DmComposer({ channelId, name }: { channelId: string; name: string }) {
  const [value, setValue] = useState("");
  const send = () => {
    const content = value.trim();
    if (!content) return;
    setValue("");
    void sendDm(channelId, content).catch((e: Error) => toast.error(e.message));
  };
  return (
    <div className="px-4">
      <textarea
        rows={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value) typing(channelId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={`Message @${name}`}
        maxLength={4000}
        className="selectable max-h-[300px] w-full resize-none rounded-lg bg-[oklch(0.335_0.009_264)] px-4 py-3 outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
