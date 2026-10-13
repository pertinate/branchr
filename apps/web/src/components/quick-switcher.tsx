/**
 * Ctrl/Cmd+K: jump to any channel, community or direct message, on any hub, by typing.
 * Alt+↑/↓: the previous or next channel in this community.
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import { AtSign, Hash, MessagesSquare, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { compareIds } from "@/lib/ids";
import { instances } from "@/lib/instances";
import { dmTitle, isUnread as dmUnread, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";
import type { AppState } from "@/stores/app";

type Item =
  | { kind: "channel"; key: string; name: string; where: string; guildId: string; channelId: string; forum: boolean; unread: boolean }
  | { kind: "guild"; key: string; name: string; where: string; guildId: string; unread: boolean }
  | { kind: "dm"; key: string; name: string; where: string; channelId: string; unread: boolean };

const unread = (s: AppState, id: string, last: string | null | undefined) => !!last && (!s.lastRead[id] || compareIds(last, s.lastRead[id]) > 0);

/** A community's text channels and forums, in channel-list order. */
export function channelOrder(s: AppState, guildId: string): string[] {
  const all = Object.values(s.channels).filter((c) => c.guildId === guildId);
  const byPos = (a: { position: number; id: string }, b: { position: number; id: string }) => a.position - b.position || compareIds(a.id, b.id);
  const inside = (parent: string | null) => all.filter((c) => (c.kind === "text" || c.kind === "forum") && c.parentId === parent).sort(byPos);
  const cats = all.filter((c) => c.kind === "category").sort(byPos);
  return [...inside(null), ...cats.flatMap((c) => inside(c.id))].map((c) => c.id);
}

function everything(): Item[] {
  const out: Item[] = [];
  for (const inst of instances()) {
    const s = inst.app.getState();
    for (const g of Object.values(s.guilds)) {
      out.push({ kind: "guild", key: `${inst.id}/g/${g.id}`, name: g.name, where: "Community", guildId: g.id, unread: false });
    }
    for (const c of Object.values(s.channels)) {
      if (c.kind !== "text" && c.kind !== "forum" && c.kind !== "thread") continue;
      const g = s.guilds[c.guildId];
      if (!g) continue;
      out.push({ kind: "channel", key: `${inst.id}/c/${c.id}`, name: c.name, where: g.name, guildId: c.guildId, channelId: c.id, forum: c.kind === "forum", unread: unread(s, c.id, c.lastMessageId) });
    }
  }
  for (const c of Object.values(useSocial.getState().channels)) {
    out.push({ kind: "dm", key: `dm/${c.id}`, name: dmTitle(c), where: "Direct message", channelId: c.id, unread: dmUnread(c) });
  }
  return out;
}

/** Best matches first: name starts with it, then a word does, then it's anywhere. */
function rank(items: Item[], query: string): Item[] {
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  if (!q) return items.filter((i) => i.unread).concat(items.filter((i) => i.kind === "guild")).slice(0, 20);
  const scored: [number, Item][] = [];
  for (const i of items) {
    const n = i.name.toLowerCase();
    const score = n.startsWith(q) ? 0 : n.split(/[\s\-_]+/).some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score + (i.unread ? -0.5 : 0), i]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length).slice(0, 20).map(([, i]) => i);
}

export function QuickSwitcher() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { guildId?: string; channelId?: string };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && params.guildId) {
        // The hub that has this community.
        const inst = instances().find((i) => i.app.getState().guilds[params.guildId!]);
        if (!inst) return;
        const order = channelOrder(inst.app.getState(), params.guildId);
        if (!order.length) return;
        e.preventDefault();
        const at = params.channelId ? order.indexOf(params.channelId) : -1;
        const down = e.key === "ArrowDown";
        // Wraps around; from outside the list, down is the first and up the last.
        const next = at === -1 ? order[down ? 0 : order.length - 1] : order[(at + (down ? 1 : -1) + order.length) % order.length];
        void navigate({ to: "/$guildId/$channelId", params: { guildId: params.guildId, channelId: next } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, params.guildId, params.channelId]);

  if (!open) return null;
  return <SwitcherDialog onClose={() => setOpen(false)} />;
}

function SwitcherDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const all = useMemo(everything, []);
  const results = useMemo(() => rank(all, query), [all, query]);
  useEffect(() => setAt(0), [query]);

  const go = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    if (i.kind === "dm") void navigate({ to: "/home/$channelId", params: { channelId: i.channelId } });
    else if (i.kind === "guild") void navigate({ to: "/$guildId", params: { guildId: i.guildId } });
    else void navigate({ to: "/$guildId/$channelId", params: { guildId: i.guildId, channelId: i.channelId } });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Quick switcher</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setAt((a) => Math.min(a + 1, results.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setAt((a) => Math.max(a - 1, 0)));
              else if (e.key === "Enter") (e.preventDefault(), go(results[at]));
            }}
            placeholder="Where would you like to go?"
            aria-label="Where would you like to go?"
            className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-2" role="listbox" aria-label="Results">
          {!results.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>}
          {results.map((r, i) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={i === at}
              onMouseEnter={() => setAt(i)}
              onClick={() => go(r)}
              className={cn("flex w-full items-center gap-2 rounded px-3 py-2 text-left", i === at && "bg-accent")}
            >
              {r.kind === "dm" ? (
                <AtSign className="size-4 shrink-0 text-muted-foreground" />
              ) : r.kind === "channel" && r.forum ? (
                <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
              ) : r.kind === "channel" ? (
                <Hash className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <span className="grid size-4 shrink-0 place-items-center rounded bg-primary text-[9px] font-bold text-white">{r.name[0]?.toUpperCase()}</span>
              )}
              <span className={cn("truncate", r.unread && "font-semibold")}>{r.name}</span>
              <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{r.where}</span>
            </button>
          ))}
        </div>
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">↑↓ to choose · Enter to go · Alt+↑↓ moves between channels</div>
      </DialogContent>
    </Dialog>
  );
}
