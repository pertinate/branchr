import { Link, useParams } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { PersonAvatar } from "@/components/home/person-avatar";
import { compareIds } from "@/lib/ids";
import { isUnread, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";

/** Friends, then your direct messages (most recent first). */
export function HomeSidebar() {
  const { channelId } = useParams({ strict: false }) as { channelId?: string };
  const channels = useSocial(
    useShallow((s) => Object.values(s.channels).sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id))),
  );
  const pending = useSocial((s) => Object.values(s.relationships).filter((r) => r.kind === "incoming").length);
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center border-b border-black/20 px-4 font-semibold shadow-sm">Direct Messages</div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        <Link
          to="/home"
          className={cn("flex items-center gap-3 rounded px-2 py-2 text-sidebar-foreground/80 hover:bg-sidebar-accent/60", !channelId && "bg-sidebar-accent text-sidebar-foreground")}
        >
          <Users className="size-5" /> Friends
          {pending > 0 && <span className="ml-auto rounded-full bg-destructive px-1.5 text-xs font-bold text-white">{pending}</span>}
        </Link>
        <div className="px-2 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Direct Messages</div>
        {channels.map((c) => {
          const p = c.recipients[0];
          if (!p) return null;
          const unread = isUnread(c) && c.id !== channelId;
          return (
            <Link
              key={c.id}
              to="/home/$channelId"
              params={{ channelId: c.id }}
              aria-label={`Message ${p.displayName}`}
              className={cn(
                "flex items-center gap-3 rounded px-2 py-1.5 hover:bg-sidebar-accent/60",
                c.id === channelId ? "bg-sidebar-accent text-sidebar-foreground" : unread ? "text-sidebar-foreground" : "text-sidebar-foreground/70",
              )}
            >
              <PersonAvatar person={p} />
              <span className={cn("truncate", unread && "font-semibold")}>{p.displayName}</span>
              {unread && <span data-testid="dm-unread" className="ml-auto size-2 shrink-0 rounded-full bg-foreground" />}
            </Link>
          );
        })}
        {channels.length === 0 && <p className="px-2 text-sm text-muted-foreground">Message a friend to start talking.</p>}
      </div>
    </aside>
  );
}
