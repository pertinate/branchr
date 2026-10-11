import { Hash } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import { useShallow } from "zustand/react/shallow";

import { MessageItem, shouldGroup } from "@/components/chat/message-item";
import { emoteMap } from "@/lib/emotes";
import { useApp } from "@/stores/app";
import { useAllEmotesById } from "@/stores/emotes";
import { type UiMessage, useMessages } from "@/stores/messages";

const LOAD_OLDER_PX = 600;

export function MessageList({ channelId, guildId, onReply }: { channelId: string; guildId: string; onReply: (m: UiMessage) => void }) {
  const state = useMessages((s) => s.channels[channelId]);
  const items = state?.items;
  const channelName = useApp((s) => s.channels[channelId]?.name);
  const emotesList = useApp(useShallow((s) => s.emotes[guildId] ?? []));
  const emotes = useMemo(() => emoteMap(emotesList), [emotesList]);
  // Reactions can use emotes from any of the user's servers.
  const emoteById = useAllEmotesById();
  const meId = useApp((s) => s.me?.id);
  const canManage = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  const [editing, setEditing] = useState<string | null>(null);

  const ref = useRef<VListHandle>(null);
  const atBottom = useRef(true);
  const [shifting, setShifting] = useState(false);
  const prevLen = useRef(0);
  const initialScrolled = useRef(false);

  useEffect(() => {
    void useMessages.getState().load(channelId);
    initialScrolled.current = false;
    atBottom.current = true;
    return () => useMessages.getState().trim(channelId);
  }, [channelId]);

  // Header row + messages.
  const rows = useMemo(() => [null, ...(items ?? [])], [items]);

  useLayoutEffect(() => {
    const len = rows.length;
    if (!ref.current || len <= 1) return;
    if (!initialScrolled.current) {
      initialScrolled.current = true;
      ref.current.scrollToIndex(len - 1, { align: "end" });
    } else if (shifting) {
      setShifting(false);
    } else if (len > prevLen.current && atBottom.current) {
      ref.current.scrollToIndex(len - 1, { align: "end", smooth: len - prevLen.current === 1 });
    }
    prevLen.current = len;
  }, [rows, shifting]);

  const onScroll = useCallback(
    (offset: number) => {
      const h = ref.current;
      if (!h) return;
      atBottom.current = offset + h.viewportSize >= h.scrollSize - 80;
      if (atBottom.current) useApp.getState().markRead(channelId);
      const s = useMessages.getState().channels[channelId];
      if (offset < LOAD_OLDER_PX && s?.hasMore && !s.loading && s.loaded) {
        setShifting(true);
        void useMessages.getState().loadOlder(channelId);
      }
    },
    [channelId],
  );

  // Up arrow in the composer edits our last message.
  useEffect(() => {
    const onEditLast = () => {
      const mine = [...(useMessages.getState().channels[channelId]?.items ?? [])].reverse().find((m) => m.author.id === meId && !m.pending);
      if (mine) setEditing(mine.id);
    };
    window.addEventListener("edit-last-message", onEditLast);
    return () => window.removeEventListener("edit-last-message", onEditLast);
  }, [channelId, meId]);

  return (
    <VList ref={ref} data={rows} shift={shifting} onScroll={onScroll} className="flex-1" style={{ overflowAnchor: "none" }}>
      {(m, i) =>
        m === null ? (
          <div key="header" className="px-4 pt-8 pb-2">
            {state?.hasMore && state.loaded ? (
              <div className="h-16 animate-pulse rounded-md bg-muted/40" />
            ) : (
              <>
                <div className="mb-2 grid size-16 place-items-center rounded-full bg-accent">
                  <Hash className="size-10" />
                </div>
                <h1 className="text-3xl font-bold">Welcome to #{channelName}!</h1>
                <p className="text-muted-foreground">This is the start of the #{channelName} channel.</p>
              </>
            )}
          </div>
        ) : (
          <MessageItem
            key={m.nonce ?? m.id}
            message={m}
            grouped={shouldGroup(rows[i - 1] ?? undefined, m)}
            guildId={guildId}
            emotes={emotes}
            emoteById={emoteById}
            canManage={canManage}
            isMine={m.author.id === meId}
            onReply={onReply}
            editing={editing === m.id}
            setEditing={setEditing}
          />
        )
      }
    </VList>
  );
}
