import { type Member, type Status, memberColor } from "@app/protocol";
import { memo, useMemo } from "react";
import { VList } from "virtua";
import { useShallow } from "zustand/react/shallow";

import { Menu, UserMenuItems } from "@/components/menus";
import { UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

type Row = { kind: "header"; label: string } | { kind: "member"; member: Member; status: Status; owner: boolean; color?: string };

export function MemberList({ guildId }: { guildId: string }) {
  const members = useApp(useShallow((s) => Object.values(s.members[guildId] ?? {})));
  const roles = useApp(useShallow((s) => s.roles[guildId] ?? []));
  const presences = useApp((s) => s.presences);
  const ownerId = useApp((s) => s.guilds[guildId]?.ownerId);

  const rows = useMemo(() => {
    const name = (m: Member) => (m.nick ?? m.user.displayName).toLowerCase();
    // Online people go under their highest "display separately" role, like Discord.
    const hoisted = roles.filter((r) => r.hoist && r.id !== guildId).sort((a, b) => b.position - a.position);
    const groups = new Map<string, Member[]>(hoisted.map((r) => [r.id, []]));
    const online: Member[] = [];
    const offline: Member[] = [];
    for (const m of members) {
      if ((presences[m.user.id] ?? "offline") === "offline") offline.push(m);
      else (groups.get(hoisted.find((r) => m.roles.includes(r.id))?.id ?? "") ?? online).push(m);
    }
    const out: Row[] = [];
    const push = (label: string, list: Member[]) => {
      if (!list.length) return;
      list.sort((a, b) => name(a).localeCompare(name(b)));
      out.push({ kind: "header", label: `${label} — ${list.length}` });
      for (const m of list) {
        out.push({ kind: "member", member: m, status: presences[m.user.id] ?? "offline", owner: m.user.id === ownerId, color: memberColor(roles, m) });
      }
    };
    for (const r of hoisted) push(r.name, groups.get(r.id)!);
    push("Online", online);
    push("Offline", offline);
    return out;
  }, [members, roles, presences, ownerId, guildId]);

  return (
    <aside className="hidden w-60 shrink-0 bg-sidebar lg:flex">
      <VList data={rows} className="flex-1 px-2 py-2">
        {(r) =>
          r.kind === "header" ? (
            <div key={r.label} className="px-2 pt-5 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {r.label}
            </div>
          ) : (
            <MemberRow key={r.member.user.id} member={r.member} status={r.status} owner={r.owner} color={r.color} />
          )
        }
      </VList>
    </aside>
  );
}

const MemberRow = memo(function MemberRow({ member, status, owner, color }: { member: Member; status: Status; owner: boolean; color?: string }) {
  return (
    <Menu items={<UserMenuItems guildId={member.guildId} userId={member.user.id} />}>
    <div className={cn("flex items-center gap-3 rounded px-2 py-1.5 hover:bg-sidebar-accent/60", status === "offline" && "opacity-40")}>
      <UserAvatar user={member.user} size={32} status={status === "offline" ? undefined : status} />
      <span className="truncate text-[15px] font-medium text-sidebar-foreground" style={{ color }}>
        {member.nick ?? member.user.displayName}
      </span>
      {owner && <span title="Server Owner" className="text-idle">♛</span>}
    </div>
    </Menu>
  );
});
