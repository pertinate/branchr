import type { Channel } from "@app/protocol";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, Hash, MicOff, Plus, Video, Volume2, HeadphoneOff } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { GuildMenu } from "@/components/guild/guild-menu";
import { MentionBadge } from "@/components/mention-badge";
import { ChannelMenuItems, Menu, UserMenuItems } from "@/components/menus";
import { UserAvatar } from "@/components/user-avatar";
import { UserPanel } from "@/components/voice/user-panel";
import { compareIds } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/ui";
import { useVoice } from "@/stores/voice";

export function ChannelSidebar({ guildId }: { guildId: string }) {
  const channels = useApp(useShallow((s) => Object.values(s.channels).filter((c) => c.guildId === guildId)));
  const isOwner = useApp((s) => s.guilds[guildId]?.ownerId === s.me?.id);
  const openDialog = useDialogs((s) => s.open);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const sorted = [...channels].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
    const cats = sorted.filter((c) => c.kind === "category");
    const children = (parent: string | null) => sorted.filter((c) => c.kind !== "category" && c.parentId === parent)
      // Text above voice inside a category, like Discord.
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "text" ? -1 : 1));
    return [{ cat: null as Channel | null, items: children(null) }, ...cats.map((cat) => ({ cat, items: children(cat.id) }))];
  }, [channels]);

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar">
      <GuildMenu guildId={guildId} />
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {groups.map(({ cat, items }) => (
          <div key={cat?.id ?? "root"} className={cat ? "pt-4" : "pt-2"}>
            {cat && (
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
                    onClick={() => openDialog({ kind: "create-channel", guildId, parentId: cat.id })}
                  >
                    <Plus className="size-4" />
                  </button>
                )}
              </div>
              </Menu>
            )}
            {items.map((c) =>
              c.kind === "voice" ? (
                <VoiceChannelRow key={c.id} channel={c} hidden={!!(cat && collapsed[cat.id])} />
              ) : cat && collapsed[cat.id] ? null : (
                <TextChannelRow key={c.id} channel={c} />
              ),
            )}
          </div>
        ))}
      </div>
      <UserPanel />
    </aside>
  );
}

const TextChannelRow = memo(function TextChannelRow({ channel }: { channel: Channel }) {
  const params = useParams({ strict: false }) as { channelId?: string };
  const active = params.channelId === channel.id;
  const unread = useApp(
    (s) => !!channel.lastMessageId && (!s.lastRead[channel.id] || compareIds(channel.lastMessageId, s.lastRead[channel.id]) > 0),
  );
  const pings = useApp((s) => s.pings[channel.id] ?? 0);
  return (
    <Menu items={<ChannelMenuItems channelId={channel.id} />}>
    <Link
      to="/$guildId/$channelId"
      params={{ guildId: channel.guildId, channelId: channel.id }}
      className={cn(
        "relative flex items-center gap-1.5 rounded px-2 py-1.5 text-[15px] font-medium",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : unread ? "text-foreground hover:bg-sidebar-accent/60" : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      {unread && !active && <span className="absolute -left-2 h-2 w-1 rounded-r-full bg-foreground" />}
      <Hash className="size-5 shrink-0 opacity-70" />
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
  const connected = useVoice((s) => s.channelId === channel.id);
  if (hidden && states.length === 0) return null;
  return (
    <div>
      <Menu items={<ChannelMenuItems channelId={channel.id} />}>
      <Link
        to="/$guildId/$channelId"
        params={{ guildId: channel.guildId, channelId: channel.id }}
        onClick={() => {
          if (!connected) void join(channel.guildId, channel.id);
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
