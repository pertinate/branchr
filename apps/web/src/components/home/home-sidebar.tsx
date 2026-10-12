import { Link, useParams } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { NewGroupDialog } from "@/components/home/new-group-dialog";
import { PersonAvatar } from "@/components/home/person-avatar";
import { compareIds } from "@/lib/ids";
import { dmTitle, isUnread, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";

/** Friends, then your direct messages (most recent first). */
export function HomeSidebar() {
  const { channelId } = useParams({ strict: false }) as { channelId?: string };
  const channels = useSocial(
    useShallow((s) => Object.values(s.channels).sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id))),
  );
  const pending = useSocial((s) => Object.values(s.relationships).filter((r) => r.kind === "incoming").length);
  const [creating, setCreating] = useState(false);
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
        <div className="flex items-center justify-between px-2 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Direct Messages
          <button aria-label="Create DM" title="Create DM" onClick={() => setCreating(true)} className="hover:text-foreground">
            <Plus className="size-4" />
          </button>
        </div>
        {creating && <NewGroupDialog onClose={() => setCreating(false)} />}
        {channels.map((c) => {
          const p = c.recipients[0];
          if (!p && !c.group) return null;
          const unread = isUnread(c) && c.id !== channelId;
          const title = dmTitle(c);
          return (
            <Link
              key={c.id}
              to="/home/$channelId"
              params={{ channelId: c.id }}
              aria-label={`Message ${title}`}
              className={cn(
                "flex items-center gap-3 rounded px-2 py-1.5 hover:bg-sidebar-accent/60",
                c.id === channelId ? "bg-sidebar-accent text-sidebar-foreground" : unread ? "text-sidebar-foreground" : "text-sidebar-foreground/70",
              )}
            >
              {c.group ? (
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-white">
                  <Users className="size-4" />
                </span>
              ) : (
                <PersonAvatar person={p} />
              )}
              <span className="min-w-0">
                <span className={cn("block truncate", unread && "font-semibold")}>{title}</span>
                {c.group && <span className="block text-xs text-muted-foreground">{c.recipients.length + 1} members</span>}
              </span>
              {unread && <span data-testid="dm-unread" className="ml-auto size-2 shrink-0 rounded-full bg-foreground" />}
            </Link>
          );
        })}
        {channels.length === 0 && <p className="px-2 text-sm text-muted-foreground">Message a friend to start talking.</p>}
      </div>
    </aside>
  );
}
