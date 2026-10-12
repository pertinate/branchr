import { PERM_GROUPS, P, type Role } from "@app/protocol";
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/lib/instances";
import { has, permsOf, roleColor, topOf } from "@/lib/perms";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

const SWATCHES = [0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b];

/** Server Settings → Roles: list on the left (highest first), the selected role on the right. */
export function RolesSettings({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const roles = useApp(useShallow((s) => s.roles[guildId] ?? []));
  const counts = useApp(
    useShallow((s) => {
      const c: Record<string, number> = {};
      for (const m of Object.values(s.members[guildId] ?? {})) for (const r of m.roles) c[r] = (c[r] ?? 0) + 1;
      return c;
    }),
  );
  const myTop = useApp((s) => topOf(s, guildId, s.me?.id));
  const myPerms = useApp((s) => permsOf(s, guildId));
  const [selected, setSelected] = useState<string>(guildId);
  const ordered = useMemo(() => [...roles].reverse(), [roles]);
  const role = roles.find((r) => r.id === selected) ?? roles.find((r) => r.id === guildId);

  const create = async () => {
    try {
      const r = await inst.api<Role>("POST", `/guilds/${guildId}/roles`, { name: "new role" });
      inst.app.getState().apply({ t: "ROLE_CREATE", d: r });
      setSelected(r.id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /** Moves a role one step up or down (skipping @everyone, which stays at the bottom). */
  const move = async (r: Role, dir: 1 | -1) => {
    const ids = roles.filter((x) => x.id !== guildId).map((x) => x.id);
    const i = ids.indexOf(r.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      const all = await inst.api<Role[]>("PATCH", `/guilds/${guildId}/roles`, { ids });
      for (const x of all) inst.app.getState().apply({ t: "ROLE_UPDATE", d: x });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[14rem_1fr] gap-4 pt-3">
      <div className="flex min-h-0 flex-col gap-2">
        <Button size="sm" onClick={create} disabled={!has(myPerms, P.MANAGE_ROLES)}>
          <Plus /> Create Role
        </Button>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" data-testid="role-list">
          {ordered.map((r, i) => {
            const everyone = r.id === guildId;
            const locked = !everyone && r.position >= myTop;
            return (
              <div
                key={r.id}
                className={cn("group flex items-center gap-2 rounded px-2 py-1.5 text-sm", r.id === role?.id ? "bg-accent" : "hover:bg-accent/50")}
              >
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelected(r.id)}>
                  <span className="size-3 shrink-0 rounded-full" style={{ background: roleColor(r) ?? "var(--muted-foreground)" }} />
                  <span className="truncate">{r.name}</span>
                  {locked && <Lock className="size-3 shrink-0 text-muted-foreground" />}
                  {!everyone && <span className="ml-auto text-xs text-muted-foreground">{counts[r.id] ?? 0}</span>}
                </button>
                {!everyone && !locked && (
                  <div className="flex opacity-0 group-hover:opacity-100">
                    <button aria-label={`Move ${r.name} up`} disabled={i === 0 || ordered[i - 1].position >= myTop} onClick={() => void move(r, 1)} className="disabled:opacity-30">
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button aria-label={`Move ${r.name} down`} disabled={ordered[i + 1]?.id === guildId} onClick={() => void move(r, -1)} className="disabled:opacity-30">
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {role && <RoleEditor key={role.id} guildId={guildId} role={role} locked={role.id !== guildId && role.position >= myTop} myPerms={myPerms} onDeleted={() => setSelected(guildId)} />}
    </div>
  );
}

function RoleEditor({ guildId, role, locked, myPerms, onDeleted }: { guildId: string; role: Role; locked: boolean; myPerms: number; onDeleted: () => void }) {
  const inst = useInstance();
  const everyone = role.id === guildId;
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<number | null>(role.color);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [perms, setPerms] = useState(role.permissions);
  // Someone else changed it: start from theirs.
  useEffect(() => {
    setName(role.name);
    setColor(role.color);
    setHoist(role.hoist);
    setMentionable(role.mentionable);
    setPerms(role.permissions);
  }, [role]);
  const dirty = name !== role.name || color !== role.color || hoist !== role.hoist || mentionable !== role.mentionable || perms !== role.permissions;

  const save = async () => {
    try {
      const body = everyone ? { permissions: perms, mentionable } : { name, color, hoist, mentionable, permissions: perms };
      const r = await inst.api<Role>("PATCH", `/guilds/${guildId}/roles/${role.id}`, body);
      inst.app.getState().apply({ t: "ROLE_UPDATE", d: r });
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the role "${role.name}"? Everyone with it loses it.`)) return;
    try {
      await inst.api("DELETE", `/guilds/${guildId}/roles/${role.id}`);
      inst.app.getState().apply({ t: "ROLE_DELETE", d: { id: role.id, guildId } });
      onDeleted();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="role-editor">
      {locked && <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">This role is at or above your highest role, so you can't change it.</p>}
      <fieldset disabled={locked} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-2">
        {!everyone && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Role name</Label>
              <Input id="role-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Color</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  aria-label="No color"
                  onClick={() => setColor(null)}
                  className={cn("size-7 rounded border border-border bg-muted", color == null && "ring-2 ring-ring")}
                />
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    aria-label={`Color #${c.toString(16)}`}
                    onClick={() => setColor(c)}
                    className={cn("size-7 rounded", color === c && "ring-2 ring-ring")}
                    style={{ background: roleColor({ color: c }) }}
                  />
                ))}
                <input
                  type="color"
                  aria-label="Custom color"
                  value={roleColor({ color: color ?? 0x99aab5 })}
                  onChange={(e) => setColor(parseInt(e.target.value.slice(1), 16))}
                  className="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
                />
              </div>
            </div>
            <Toggle id="role-hoist" label="Display separately" hint="Members with this role are listed under it in the member list." checked={hoist} onChange={setHoist} />
          </>
        )}
        <Toggle
          id="role-mentionable"
          label={everyone ? "Allow anyone to @mention roles" : "Allow anyone to @mention this role"}
          hint={everyone ? "Doesn't affect @everyone; see Mention @everyone below." : "People with Mention @everyone can always ping it."}
          checked={mentionable}
          onChange={setMentionable}
          hidden={everyone}
        />
        {PERM_GROUPS.map((g) => (
          <div key={g.title} className="space-y-1">
            <div className="pt-2 text-xs font-semibold text-muted-foreground uppercase">{g.title} permissions</div>
            {g.perms.map(({ perm, label, hint }) => {
              const bit = P[perm];
              // You can't grant what you don't have, but may keep or remove it.
              const grantable = has(myPerms, bit) || (role.permissions & bit) !== 0;
              return (
                <Toggle
                  key={perm}
                  id={`perm-${perm}`}
                  label={label}
                  hint={hint}
                  checked={(perms & bit) !== 0}
                  disabled={!grantable}
                  onChange={(on) => setPerms((p) => (on ? p | bit : p & ~bit))}
                />
              );
            })}
          </div>
        ))}
      </fieldset>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {!everyone && !locked && (
          <Button variant="ghost" className="text-destructive" onClick={remove}>
            <Trash2 /> Delete Role
          </Button>
        )}
        <Button className="ml-auto" disabled={!dirty || locked} onClick={save}>
          Save Changes
        </Button>
      </div>
    </div>
  );
}

function Toggle(props: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hidden?: boolean }) {
  if (props.hidden) return null;
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div>
        <Label htmlFor={props.id}>{props.label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{props.hint}</p>
      </div>
      <Switch id={props.id} checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
    </div>
  );
}
