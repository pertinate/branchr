import type { Channel } from "@app/protocol";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessagesSquare, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { MentionBadge } from "@/components/mention-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { compareIds, snowflakeTime } from "@/lib/ids";
import { useInstance } from "@/lib/instances";
import { P, useChannelCan } from "@/lib/perms";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

/** "5m ago", "3h ago", "Mar 4". */
function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A forum: its posts, most recently active first, and a button to start one. */
export function ForumView({ guildId, channel }: { guildId: string; channel: Channel }) {
  const posts = useApp(useShallow((s) => Object.values(s.channels).filter((c) => c.kind === "thread" && c.parentId === channel.id)));
  const sorted = useMemo(() => [...posts].sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id)), [posts]);
  const canPost = useChannelCan(channel.id, P.SEND_MESSAGES);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-black/20 px-4 py-3">
        <p className="flex-1 truncate text-sm text-muted-foreground">{channel.topic || "Each post is its own conversation."}</p>
        {canPost && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New Post
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4" data-testid="forum-posts">
        {!sorted.length && (
          <div className="grid place-items-center gap-2 py-16 text-center text-muted-foreground">
            <MessagesSquare className="size-10" />
            <p>No posts yet.{canPost && " Start the first one."}</p>
          </div>
        )}
        {sorted.map((p) => (
          <PostRow key={p.id} guildId={guildId} post={p} />
        ))}
      </div>
      {creating && <NewPostDialog guildId={guildId} forum={channel} onClose={() => setCreating(false)} />}
    </div>
  );
}

function PostRow({ guildId, post }: { guildId: string; post: Channel }) {
  const author = useApp((s) => (post.ownerId ? (s.members[guildId]?.[post.ownerId]?.nick ?? s.members[guildId]?.[post.ownerId]?.user.displayName) : undefined));
  const unread = useApp((s) => !!post.lastMessageId && (!s.lastRead[post.id] || compareIds(post.lastMessageId, s.lastRead[post.id]) > 0));
  const pings = useApp((s) => s.pings[post.id] ?? 0);
  return (
    <Link
      to="/$guildId/$channelId"
      params={{ guildId, channelId: post.id }}
      data-testid="forum-post"
      className="flex items-center gap-3 rounded-lg border border-border bg-sidebar/60 px-4 py-3 hover:border-muted-foreground"
    >
      <div className="min-w-0 flex-1">
        <div className={cn("truncate font-semibold", !unread && "text-muted-foreground")}>{post.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {author ? `${author} · ` : ""}
          {ago(snowflakeTime(post.lastMessageId ?? post.id))}
        </div>
      </div>
      {pings > 0 && <MentionBadge count={pings} />}
    </Link>
  );
}

function NewPostDialog({ guildId, forum, onClose }: { guildId: string; forum: Channel; onClose: () => void }) {
  const inst = useInstance();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const thread = await inst.api<Channel>("POST", `/channels/${forum.id}/threads`, { name: title.trim() });
      await inst.api("POST", `/channels/${thread.id}/messages`, { content: body.trim() });
      onClose();
      void navigate({ to: "/$guildId/$channelId", params: { guildId, channelId: thread.id } });
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Post</DialogTitle>
          <DialogDescription>In #{forum.name}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={post} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="post-title">Title</Label>
            <Input id="post-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="post-body">Message</Label>
            <Textarea id="post-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={5} className="resize-none" />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={!title.trim() || !body.trim() || busy}>
              Post
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
