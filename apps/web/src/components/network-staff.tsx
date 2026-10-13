import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { branchrApi } from "@/lib/branchr-id";

type Role = "admin" | "moderator";
interface Who {
  id: string;
  handle: string;
  displayName: string;
}
interface Ban {
  account: Who;
  reason: string;
  bannedBy: string | null;
  createdAt: number;
}
interface Staff {
  account: Who;
  role: Role;
}

/** branchr's own staff: network-wide bans (admins and moderators), and the staff list (admins). */
export function NetworkStaff() {
  const me = useQuery({ queryKey: ["network-me"], queryFn: () => branchrApi<{ role: Role | null }>("GET", "/network/me") });
  const role = me.data?.role;
  if (!role) return null;
  return (
    <div className="space-y-4 border-t border-border pt-4" data-testid="network-staff">
      <div>
        <div className="text-xs font-semibold text-muted-foreground uppercase">branchr network</div>
        <p className="text-xs text-muted-foreground">You're branchr {role === "admin" ? "an admin" : "a moderator"}. A ban here signs the account out of branchr and keeps it out of every hub.</p>
      </div>
      <Bans />
      {role === "admin" && <StaffList />}
    </div>
  );
}

function useRun() {
  const qc = useQueryClient();
  return async (f: () => Promise<unknown>, keys: string[][]) => {
    try {
      await f();
      for (const k of keys) await qc.invalidateQueries({ queryKey: k });
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
}

function Bans() {
  const bans = useQuery({ queryKey: ["network-bans"], queryFn: () => branchrApi<Ban[]>("GET", "/network/bans") });
  const run = useRun();
  const [handle, setHandle] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const h = handle.trim().replace(/^@/, "");
          if (!h || !reason.trim() || !confirm(`Ban @${h} from all of branchr?`)) return;
          void run(() => branchrApi("PUT", `/network/bans/${encodeURIComponent(h)}`, { reason: reason.trim() }), [["network-bans"]]).then((ok) => {
            if (ok) {
              setHandle("");
              setReason("");
            }
          });
        }}
      >
        <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="handle" aria-label="Handle to ban" className="w-36" />
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" aria-label="Ban reason" maxLength={500} className="min-w-40 flex-1" />
        <Button type="submit" size="sm" variant="destructive" disabled={!handle.trim() || !reason.trim()}>
          Ban
        </Button>
      </form>
      {bans.data?.length === 0 && <p className="text-xs text-muted-foreground">No one is banned.</p>}
      {bans.data?.map((b) => (
        <div key={b.account.id} data-testid="network-ban" className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {b.account.displayName} <span className="text-muted-foreground">@{b.account.handle}</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {b.reason} · {b.bannedBy ? `by @${b.bannedBy}` : ""} {new Date(b.createdAt).toLocaleDateString()}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void run(() => branchrApi("DELETE", `/network/bans/${encodeURIComponent(b.account.handle)}`), [["network-bans"]])}>
            Unban
          </Button>
        </div>
      ))}
    </div>
  );
}

function StaffList() {
  const staff = useQuery({ queryKey: ["network-staff"], queryFn: () => branchrApi<Staff[]>("GET", "/network/staff") });
  const run = useRun();
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState<Role>("moderator");
  const set = (h: string, r: Role) => run(() => branchrApi("PUT", `/network/staff/${encodeURIComponent(h)}`, { role: r }), [["network-staff"]]);
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase">Staff</div>
      {staff.data?.map((s) => (
        <div key={s.account.id} data-testid="network-staff-member" className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            {s.account.displayName} <span className="text-muted-foreground">@{s.account.handle}</span>
          </span>
          <Select value={s.role} onValueChange={(r) => void set(s.account.handle, r as Role)}>
            <SelectTrigger size="sm" className="w-32" aria-label={`Role for @${s.account.handle}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="moderator">Moderator</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => confirm(`Take @${s.account.handle} off branchr's staff?`) && void run(() => branchrApi("DELETE", `/network/staff/${encodeURIComponent(s.account.handle)}`), [["network-staff"]])}
          >
            Remove
          </Button>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const h = handle.trim().replace(/^@/, "");
          if (h) void set(h, role).then((ok) => ok && setHandle(""));
        }}
      >
        <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="handle" aria-label="Staff handle" className="flex-1" />
        <Select value={role} onValueChange={(r) => setRole(r as Role)}>
          <SelectTrigger className="w-32" aria-label="New staff role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="moderator">Moderator</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={!handle.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
