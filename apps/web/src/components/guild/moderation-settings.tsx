import { type AuditChange, type AuditEntry, type AuditLog, type GuildBan, PERM_GROUPS, P, type User } from "@app/protocol";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { useInstance } from "@/lib/instances";
import { snowflakeTime } from "@/lib/ids";
import { useApp } from "@/stores/app";

/** Server Settings → Bans: who's banned, why, and a way back. */
export function BansSettings({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const qc = useQueryClient();
  const bans = useQuery({ queryKey: ["bans", inst.id, guildId], queryFn: () => inst.api<GuildBan[]>("GET", `/guilds/${guildId}/bans`) });
  const unban = async (b: GuildBan) => {
    try {
      await inst.api("DELETE", `/guilds/${guildId}/bans/${b.user.id}`);
      toast.success(`Unbanned ${b.user.displayName}`);
      void qc.invalidateQueries({ queryKey: ["bans", inst.id, guildId] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="h-full overflow-y-auto pt-3" data-testid="ban-list">
      {bans.data?.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Nobody is banned.</p>}
      <div className="divide-y divide-border">
        {bans.data?.map((b) => (
          <div key={b.user.id} className="flex items-center gap-3 py-2">
            <UserAvatar user={b.user} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{b.user.displayName}</div>
              <div className="truncate text-xs text-muted-foreground">
                @{b.user.username} · {new Date(b.createdAt).toLocaleDateString()}
                {b.reason && ` · "${b.reason}"`}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void unban(b)}>
              <Undo2 /> Unban
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

const PERM_LABELS = new Map(PERM_GROUPS.flatMap((g) => g.perms.map((p) => [P[p.perm], p.label] as const)));

/** A permissions number as the names that changed between `old` and `now`. */
function permDiff(old: string | null, now: string | null): string {
  const a = Number(old ?? 0);
  const b = Number(now ?? 0);
  const names = (bits: number) => [...PERM_LABELS].filter(([bit]) => bits & bit).map(([, l]) => l);
  const added = names(b & ~a);
  const removed = names(a & ~b);
  return [added.length ? `+ ${added.join(", ")}` : "", removed.length ? `− ${removed.join(", ")}` : ""].filter(Boolean).join("; ") || "no change";
}

const VERBS: Record<AuditEntry["action"], string> = {
  guild_update: "updated the server",
  channel_create: "created the channel",
  channel_update: "updated the channel",
  channel_delete: "deleted the channel",
  channel_overwrite_update: "changed permissions in",
  channel_overwrite_delete: "removed a permission override in",
  member_kick: "kicked",
  member_ban_add: "banned",
  member_ban_remove: "unbanned",
  member_role_add: "gave a role to",
  member_role_remove: "took a role from",
  role_create: "created the role",
  role_update: "updated the role",
  role_delete: "deleted the role",
  emote_create: "added",
  emote_update: "renamed the emote",
  emote_delete: "removed the emote",
  message_delete: "deleted a message by",
};

/** Server Settings → Audit Log: newest first, loading older pages on demand. */
export function AuditLogSettings({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const roles = useApp((s) => s.roles[guildId] ?? []);
  const members = useApp((s) => s.members[guildId] ?? {});
  const log = useInfiniteQuery({
    queryKey: ["audit", inst.id, guildId],
    queryFn: ({ pageParam }) => inst.api<AuditLog>("GET", `/guilds/${guildId}/audit-log?limit=50${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.entries.length === 50 ? last.entries[last.entries.length - 1].id : undefined),
  });
  const users = new Map<string, User>();
  for (const p of log.data?.pages ?? []) for (const u of p.users) users.set(u.id, u);
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  const nameOf = (id: string) => members[id]?.nick ?? users.get(id)?.displayName ?? "someone";

  const changeText = (c: AuditChange): string => {
    const ow = /^(role|member) (\d+)(?: (allow|deny))?$/.exec(c.key);
    if (ow) {
      const who = ow[1] === "role" ? `@${roles.find((r) => r.id === ow[2])?.name ?? "deleted role"}` : nameOf(ow[2]);
      return ow[3] ? `${who} ${ow[3]}: ${permDiff(c.old, c.new)}` : `${who}: override removed`;
    }
    if (c.key === "permissions") return `permissions: ${permDiff(c.old, c.new)}`;
    if (c.key === "role") return `role: ${c.new ?? c.old}`;
    return `${c.key}: ${c.old ?? "none"} → ${c.new ?? "none"}`;
  };

  return (
    <div className="h-full overflow-y-auto pt-3" data-testid="audit-log">
      {log.data && entries.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Nothing has happened yet.</p>}
      <div className="divide-y divide-border">
        {entries.map((e) => {
          const actor = users.get(e.actorId);
          const isPerson = e.action.startsWith("member_") || e.action === "message_delete";
          const target = isPerson && e.targetId ? nameOf(e.targetId) : e.targetName;
          const prefix = e.action.startsWith("channel_") ? "#" : e.action.startsWith("role_") ? "@" : "";
          return (
            <div key={e.id} className="flex gap-3 py-2.5" data-testid="audit-entry">
              {actor ? <UserAvatar user={actor} size={32} /> : <div className="size-8" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-medium">{nameOf(e.actorId)}</span> {VERBS[e.action]}{" "}
                  {target && (
                    <span className="font-medium">
                      {prefix}
                      {target}
                    </span>
                  )}
                </div>
                {e.changes.map((c, i) => (
                  <div key={i} className="truncate text-xs text-muted-foreground">
                    {changeText(c)}
                  </div>
                ))}
                {e.reason && <div className="text-xs text-muted-foreground">Reason: {e.reason}</div>}
              </div>
              <time className="shrink-0 text-xs text-muted-foreground">{new Date(snowflakeTime(e.id)).toLocaleString()}</time>
            </div>
          );
        })}
      </div>
      {log.hasNextPage && (
        <div className="py-3 text-center">
          <Button size="sm" variant="ghost" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}
