import type { Channel } from "@app/protocol";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, CornerDownRight, FolderPlus, Hash, PlusCircle, UserPlus, MicOff, Plus, Video, Volume2, HeadphoneOff } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { GuildMenu } from "@/components/guild/guild-menu";
import { MentionBadge } from "@/components/mention-badge";
import { ChannelMenuItems, Menu, UserMenuItems } from "@/components/menus";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { UserAvatar } from "@/components/user-avatar";
import { type ChannelDrop, reorder } from "@/lib/channel-order";
import { compareIds } from "@/lib/ids";
import { useInstance } from "@/lib/instances";
import { cn } from "@/lib/utils";
import { useMediaUrl } from "@/lib/media";
import { P, useCan } from "@/lib/perms";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/ui";
import { useVoice } from "@/stores/voice";

export function ChannelSidebar({ guildId }: { guildId: string }) {
  const channels = useApp(useShallow((s) => Object.values(s.channels).filter((c) => c.guildId === guildId)));
  const isOwner = useCan(guildId, P.MANAGE_CHANNELS);
  const openDialog = useDialogs((s) => s.open);
  const instanceId = useInstance().id;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const inst = useInstance();
  // Dragging channels and categories around (people who can manage channels).
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<ChannelDrop | null>(null);
  const dnd = useMemo<Dnd>(
    () => ({
      enabled: isOwner,
      dragging,
      hint,
      setHint,
      start: setDragging,
      end: () => {
        setDragging(null);
        setHint(null);
      },
      drop: (drop) => {
        const id = dragging;
        setDragging(null);
        setHint(null);
        if (!id) return;
        const changes = reorder(channels, id, drop);
        if (!changes.length) return;
        // Shown at once; the server's updates follow.
        const app = inst.app.getState();
        for (const p of changes) {
          const c = app.channels[p.id];
          if (c) app.apply({ t: "CHANNEL_UPDATE", d: { ...c, position: p.position, parentId: p.parentId } });
        }
        void inst.api("PATCH", `/guilds/${guildId}/channels`, changes).catch((e: Error) => toast.error(e.message));
      },
    }),
    [isOwner, dragging, hint, channels, inst, guildId],
  );

  const groups = useMemo(() => {
    const sorted = [...channels].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
    const cats = sorted.filter((c) => c.kind === "category");
    const children = (parent: string | null) => sorted.filter((c) => c.kind !== "category" && c.kind !== "thread" && c.parentId === parent)
      // Text above voice inside a category, like Discord.
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "text" ? -1 : 1));
    // Each channel's threads, most recently active first.
    const threads = new Map<string, Channel[]>();
    for (const t of sorted.filter((c) => c.kind === "thread" && c.parentId)) threads.set(t.parentId!, [...(threads.get(t.parentId!) ?? []), t]);
    for (const list of threads.values()) list.sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id));
    return {
      threads,
      list: [{ cat: null as Channel | null, items: children(null) }, ...cats.map((cat) => ({ cat, items: children(cat.id) }))],
    };
  }, [channels]);

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar">
      <GuildMenu guildId={guildId} />
      <GuildBanner guildId={guildId} />
      <Menu items={<ChannelListMenuItems guildId={guildId} />}>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2" data-testid="channel-list">
        {groups.list.map(({ cat, items }) => (
          <div key={cat?.id ?? "root"} className={cat ? "pt-4" : "pt-2"}>
            {cat && (
              <DragRow dnd={dnd} id={cat.id} category>
              <Menu items={<ChannelMenuItems channelId={cat.id} />}>
              <div className="group flex items-center pr-1">
                <button
                  className="flex flex-1 items-center gap-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  onClick={() => setCollapsed((c) => ({ ...c, [cat.id]: !c[cat.id] }))}
                >
                  <ChevronDown className={cn("size-3 transition-transform", collapsed[cat.id] && "-rotate-90")} />
                  {cat.name}
                </button>
                {isOwner && (
                  <button
                    className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                    aria-label={`Create channel in ${cat.name}`}
                    onClick={() => openDialog({ instanceId, kind: "create-channel", guildId, parentId: cat.id })}
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </div>
              </Menu>
              </DragRow>
            )}
            {items.map((c) =>
              c.kind === "voice" ? (
                <DragRow key={c.id} dnd={dnd} id={c.id}>
                  <VoiceChannelRow channel={c} hidden={!!(cat && collapsed[cat.id])} />
                </DragRow>
              ) : cat && collapsed[cat.id] ? null : (
                <div key={c.id}>
                  <DragRow dnd={dnd} id={c.id}>
                    <TextChannelRow channel={c} />
                  </DragRow>
                  {groups.threads.get(c.id)?.slice(0, MAX_THREADS).map((t) => <TextChannelRow key={t.id} channel={t} thread />)}
                </div>
              ),
            )}
          </div>
        ))}
      </div>
      </Menu>
    </aside>
  );
}

interface Dnd {
  enabled: boolean;
  dragging: string | null;
  hint: ChannelDrop | null;
  setHint: (h: ChannelDrop | null) => void;
  start: (id: string) => void;
  end: () => void;
  drop: (d: ChannelDrop) => void;
}

/** A draggable spot in the channel list, showing where a drop would land. */
function DragRow({ dnd, id, category, children }: { dnd: Dnd; id: string; category?: boolean; children: React.ReactNode }) {
  const mine = dnd.hint?.id === id ? dnd.hint.zone : null;
  if (!dnd.enabled) return <>{children}</>;
  return (
    <div
      data-channel-row={id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-branchr-channel", id);
        dnd.start(id);
      }}
      onDragEnd={dnd.end}
      onDragOver={(e) => {
        if (!dnd.dragging || dnd.dragging === id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const lower = e.clientY - r.top > r.height / 2;
        // A channel dropped on a category goes into it; categories line up with each other.
        const draggingCategory = !!document.querySelector(`[data-channel-row="${dnd.dragging}"][data-category]`);
        const zone = category && !draggingCategory ? "into" : lower ? "after" : "before";
        if (mine !== zone) dnd.setHint({ id, zone });
      }}
      onDragLeave={(e) => {
        if (mine && !e.currentTarget.contains(e.relatedTarget as Node)) dnd.setHint(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dnd.hint?.id === id) dnd.drop(dnd.hint);
      }}
      data-category={category || undefined}
      className="relative"
    >
      {mine === "before" && <span className="pointer-events-none absolute -top-px right-1 left-1 h-0.5 rounded bg-primary" />}
      {mine === "after" && <span className="pointer-events-none absolute right-1 -bottom-px left-1 h-0.5 rounded bg-primary" />}
      {mine === "into" && <span className="pointer-events-none absolute inset-0 rounded ring-2 ring-primary" />}
      {children}
    </div>
  );
}

/** Threads shown under a channel (the most recently active). */
const MAX_THREADS = 10;

/** Right-click on the channel list's empty space. */
function ChannelListMenuItems({ guildId }: { guildId: string }) {
  const canChannels = useCan(guildId, P.MANAGE_CHANNELS);
  const canInvite = useCan(guildId, P.CREATE_INVITE);
  const instanceId = useInstance().id;
  const open = useDialogs((s) => s.open);
  return (
    <>
      {canChannels && (
        <>
          <ContextMenuItem onSelect={() => open({ instanceId, kind: "create-channel", guildId, parentId: null })}>
            Create Channel <PlusCircle className="ml-auto" />
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => open({ instanceId, kind: "create-channel", guildId, parentId: null, channelKind: "category" })}>
            Create Category <FolderPlus className="ml-auto" />
          </ContextMenuItem>
        </>
      )}
      {canInvite && (
        <ContextMenuItem onSelect={() => open({ instanceId, kind: "invite", guildId })}>
          Invite People <UserPlus className="ml-auto" />
        </ContextMenuItem>
      )}
      {!canChannels && !canInvite && <ContextMenuItem disabled>Nothing to do here</ContextMenuItem>}
    </>
  );
}

const TextChannelRow = memo(function TextChannelRow({ channel, thread }: { channel: Channel; thread?: boolean }) {
  const params = useParams({ strict: false }) as { channelId?: string };
  const active = params.channelId === channel.id;
  const unread = useApp(
    (s) => !!channel.lastMessageId && (!s.lastRead[channel.id] || compareIds(channel.lastMessageId, s.lastRead[channel.id]) > 0),
  );
  const pings = useApp((s) => s.pings[channel.id] ?? 0);
  const instance = useInstance().id;
  return (
    <Menu items={<ChannelMenuItems channelId={channel.id} />}>
    <Link
      draggable={false}
      to="/$instance/$guildId/$channelId"
      params={{ instance, guildId: channel.guildId, channelId: channel.id }}
      data-thread={thread || undefined}
      className={cn(
        "relative flex items-center gap-1.5 rounded px-2 py-1.5 text-[15px] font-medium",
        thread && "ml-5 py-1 text-sm",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : unread ? "text-foreground hover:bg-sidebar-accent/60" : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      {unread && !active && <span className="absolute -left-2 h-2 w-1 rounded-r-full bg-foreground" />}
      {thread ? <CornerDownRight className="size-4 shrink-0 opacity-60" /> : <Hash className="size-5 shrink-0 opacity-70" />}
      <span className="truncate">{channel.name}</span>
      {pings > 0 && !active && <MentionBadge count={pings} className="ml-auto" />}
    </Link>
    </Menu>
  );
});

const VoiceChannelRow = memo(function VoiceChannelRow({ channel, hidden }: { channel: Channel; hidden: boolean }) {
  const params = useParams({ strict: false }) as { channelId?: string };
  const states = useApp(useShallow((s) => Object.values(s.voice[channel.guildId] ?? {}).filter((v) => v.channelId === channel.id)));
  const join = useVoice((s) => s.join);
  const instanceId = useInstance().id;
  const connected = useVoice((s) => s.channelId === channel.id && s.instanceId === instanceId);
  const instance = useInstance().id;
  if (hidden && states.length === 0) return null;
  return (
    <div>
      <Menu items={<ChannelMenuItems channelId={channel.id} />}>
      <Link
        draggable={false}
        to="/$instance/$guildId/$channelId"
        params={{ instance, guildId: channel.guildId, channelId: channel.id }}
        onClick={() => {
          if (!connected) void join(channel.guildId, channel.id, instanceId);
        }}
        className={cn(
          "flex items-center gap-1.5 rounded px-2 py-1.5 text-[15px] font-medium",
          params.channelId === channel.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
        )}
      >
        <Volume2 className="size-5 shrink-0 opacity-70" />
        <span className="truncate">{channel.name}</span>
      </Link>
      </Menu>
      {states.length > 0 && (
        <div className="space-y-0.5 py-0.5 pl-8">
          {states.map((v) => (
            <VoiceParticipant key={v.userId} guildId={channel.guildId} userId={v.userId} mute={v.selfMute} deaf={v.selfDeaf} video={v.selfVideo} live={v.selfStream} />
          ))}
        </div>
      )}
    </div>
  );
});

const VoiceParticipant = memo(function VoiceParticipant(p: {
  guildId: string;
  userId: string;
  mute: boolean;
  deaf: boolean;
  video: boolean;
  live: boolean;
}) {
  const member = useApp((s) => s.members[p.guildId]?.[p.userId]);
  const speaking = useVoice((s) => !!s.speaking[p.userId]);
  if (!member) return null;
  return (
    <Menu items={<UserMenuItems guildId={p.guildId} userId={p.userId} />}>
    <div className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent/60">
      <UserAvatar user={member.user} size={22} speaking={speaking} />
      <span className={cn("flex-1 truncate", speaking && "text-foreground")}>{member.nick ?? member.user.displayName}</span>
      {p.live && <span className="rounded bg-live px-1 text-[10px] font-bold text-white">LIVE</span>}
      {p.video && <Video className="size-3.5" />}
      {p.deaf ? <HeadphoneOff className="size-3.5 text-destructive" /> : p.mute && <MicOff className="size-3.5 text-destructive" />}
    </div>
    </Menu>
  );
});

function GuildBanner({ guildId }: { guildId: string }) {
  const banner = useMediaUrl(useApp((s) => s.guilds[guildId]?.bannerUrl));
  if (!banner) return null;
  return <img src={banner} alt="" data-testid="guild-banner" className="aspect-video w-full shrink-0 object-cover" draggable={false} />;
}
