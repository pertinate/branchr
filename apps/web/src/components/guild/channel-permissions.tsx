import { type Channel, type OverwriteKind, type Perm, PERM_GROUPS, P } from "@app/protocol";
import { Check, Slash, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useInstance } from "@/lib/instances";
import { channelPermsOf, roleColor } from "@/lib/perms";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

/** Server-wide permissions that mean nothing on one channel. */
const GUILD_ONLY: Perm[] = ["MANAGE_GUILD", "MANAGE_EMOTES", "KICK_MEMBERS", "BAN_MEMBERS", "CHANGE_NICKNAME", "MANAGE_NICKNAMES", "ADMINISTRATOR"];
const TEXT_ONLY: Perm[] = ["SEND_MESSAGES", "ATTACH_FILES", "ADD_REACTIONS", "USE_EXTERNAL_EMOTES", "MENTION_EVERYONE", "MANAGE_MESSAGES"];
const VOICE_ONLY: Perm[] = ["CONNECT", "SPEAK", "VIDEO", "STREAM", "MUTE_MEMBERS", "DEAFEN_MEMBERS", "MOVE_MEMBERS"];

type Target = { kind: OverwriteKind; id: string };
const key = (t: Target) => `${t.kind}:${t.id}`;

/** Channel settings → Permissions: overwrites for roles and members, three states each. */
export function ChannelPermissions({ channel }: { channel: Channel }) {
  const inst = useInstance();
  const gid = channel.guildId;
  const roles = useApp(useShallow((s) => s.roles[gid] ?? []));
  const members = useApp((s) => s.members[gid] ?? {});
  const mine = useApp((s) => channelPermsOf(s, channel.id));
  const [selected, setSelected] = useState<string>(`role:${gid}`);

  const groups = useMemo(
    () =>
      PERM_GROUPS.map((g) => ({
        ...g,
        perms: g.perms.filter(
          ({ perm }) => !GUILD_ONLY.includes(perm) && !(channel.kind === "voice" && TEXT_ONLY.includes(perm)) && !(channel.kind === "text" && VOICE_ONLY.includes(perm)),
        ),
      })).filter((g) => g.perms.length),
    [channel.kind],
  );

  const name = (t: Target) => {
    if (t.kind === "role") return roles.find((r) => r.id === t.id)?.name ?? "deleted role";
    const m = members[t.id];
    return m ? (m.nick ?? m.user.displayName) : "someone who left";
  };
  // @everyone is always listed, with or without an overwrite.
  const listed: Target[] = [{ kind: "role", id: gid }, ...channel.overwrites.filter((o) => !(o.kind === "role" && o.id === gid)).map((o) => ({ kind: o.kind, id: o.id }))];
  const addable = [
    ...roles.filter((r) => !listed.some((t) => t.kind === "role" && t.id === r.id)).map((r) => ({ kind: "role" as const, id: r.id, label: r.name })),
    ...Object.values(members)
      .filter((m) => !listed.some((t) => t.kind === "member" && t.id === m.user.id))
      .slice(0, 50)
      .map((m) => ({ kind: "member" as const, id: m.user.id, label: `@${m.user.username}` })),
  ];
  const current = listed.find((t) => key(t) === selected) ?? listed[0];
  const overwrite = channel.overwrites.find((o) => o.kind === current.kind && o.id === current.id);

  const saved = (c: Channel) => inst.app.getState().apply({ t: "CHANNEL_UPDATE", d: c });
  const put = async (t: Target, allow: number, deny: number) => {
    try {
      saved(await inst.api<Channel>("PUT", `/channels/${channel.id}/permissions/${t.id}`, { kind: t.kind, allow, deny }));
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  const remove = async (t: Target) => {
    try {
      saved(await inst.api<Channel>("DELETE", `/channels/${channel.id}/permissions/${t.kind}/${t.id}`));
      setSelected(`role:${gid}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[12rem_1fr] gap-4 pt-3">
      <div className="flex min-h-0 flex-col gap-2">
        <Select
          value=""
          onValueChange={(v) => {
            const [kind, id] = v.split(":") as [OverwriteKind, string];
            // An empty overwrite lists them; set switches next.
            void put({ kind, id }, 0, 0).then((ok) => ok && setSelected(v));
          }}
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Add a role or member">
            <SelectValue placeholder="Add a role or member" />
          </SelectTrigger>
          <SelectContent>
            {addable.map((a) => (
              <SelectItem key={`${a.kind}:${a.id}`} value={`${a.kind}:${a.id}`}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" data-testid="overwrite-list">
          {listed.map((t) => {
            const role = t.kind === "role" ? roles.find((r) => r.id === t.id) : undefined;
            return (
              <button
                key={key(t)}
                onClick={() => setSelected(key(t))}
                className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm", key(t) === key(current) ? "bg-accent" : "hover:bg-accent/50")}
              >
                {t.kind === "role" ? (
                  <span className="size-3 shrink-0 rounded-full" style={{ background: (role && roleColor(role)) ?? "var(--muted-foreground)" }} />
                ) : (
                  <span className="text-xs text-muted-foreground">@</span>
                )}
                <span className="truncate">{name(t)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <OverwriteEditor
        key={key(current)}
        groups={groups}
        allow={overwrite?.allow ?? 0}
        deny={overwrite?.deny ?? 0}
        mine={mine}
        title={name(current)}
        removable={!!overwrite && !(current.kind === "role" && current.id === gid)}
        onSave={(allow, deny) => put(current, allow, deny)}
        onRemove={() => remove(current)}
      />
    </div>
  );
}

function OverwriteEditor(props: {
  groups: typeof PERM_GROUPS;
  allow: number;
  deny: number;
  mine: number;
  title: string;
  removable: boolean;
  onSave: (allow: number, deny: number) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [allow, setAllow] = useState(props.allow);
  const [deny, setDeny] = useState(props.deny);
  useEffect(() => {
    setAllow(props.allow);
    setDeny(props.deny);
  }, [props.allow, props.deny]);
  const dirty = allow !== props.allow || deny !== props.deny;
  const set = (bit: number, state: "deny" | "neutral" | "allow") => {
    setAllow((a) => (state === "allow" ? a | bit : a & ~bit));
    setDeny((d) => (state === "deny" ? d | bit : d & ~bit));
  };
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="overwrite-editor">
      <div className="text-sm font-semibold">{props.title}</div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        {props.groups.map((g) => (
          <div key={g.title} className="space-y-1">
            <div className="pt-2 text-xs font-semibold text-muted-foreground uppercase">{g.title}</div>
            {g.perms.map(({ perm, label, hint }) => {
              const bit = P[perm];
              const state = allow & bit ? "allow" : deny & bit ? "deny" : "neutral";
              // Only permissions we have here can be changed (as on the server).
              const locked = !(props.mine & bit);
              return (
                <div key={perm} className="flex items-center justify-between gap-4 py-1.5">
                  <div>
                    <div className="text-sm">{label}</div>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                  <div className="flex shrink-0 overflow-hidden rounded-md border border-border" role="radiogroup" aria-label={label}>
                    {(
                      [
                        ["deny", X, "bg-destructive text-white"],
                        ["neutral", Slash, "bg-muted"],
                        ["allow", Check, "bg-green-600 text-white"],
                      ] as const
                    ).map(([s, Icon, on]) => (
                      <button
                        key={s}
                        role="radio"
                        aria-checked={state === s}
                        aria-label={`${label}: ${s}`}
                        disabled={locked}
                        onClick={() => set(bit, s)}
                        className={cn("px-2 py-1 disabled:opacity-40", state === s ? on : "text-muted-foreground hover:bg-accent")}
                      >
                        <Icon className="size-3.5" />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {props.removable && (
          <Button variant="ghost" className="text-destructive" onClick={props.onRemove}>
            <Trash2 /> Remove
          </Button>
        )}
        <Button className="ml-auto" disabled={!dirty} onClick={() => void props.onSave(allow, deny)}>
          Save Changes
        </Button>
      </div>
    </div>
  );
}
