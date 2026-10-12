import type { Relationship } from "@app/protocol";
import { useNavigate } from "@tanstack/react-router";
import { Check, MessageCircle, Undo2, UserX, Users, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { PersonAvatar } from "@/components/home/person-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acceptFriend, addFriend, blockPerson, openDm, removeRelationship, useSocial } from "@/lib/social";
import { cn } from "@/lib/utils";

type Tab = "online" | "all" | "pending" | "blocked" | "add";

async function attempt(f: () => Promise<unknown>, ok?: string) {
  try {
    await f();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error((e as Error).message);
  }
}

/** Home → Friends: who's around, requests, blocks, and adding people by handle. */
export function FriendsPage() {
  const [tab, setTab] = useState<Tab>("online");
  const me = useSocial((s) => s.me);
  const all = useSocial(useShallow((s) => Object.values(s.relationships).sort((a, b) => a.person.displayName.localeCompare(b.person.displayName))));
  const online = useSocial((s) => s.online);
  const pending = all.filter((r) => r.kind === "incoming").length;
  const shown = all.filter((r) =>
    tab === "online" ? r.kind === "friend" && online[r.person.id] : tab === "all" ? r.kind === "friend" : tab === "pending" ? r.kind === "incoming" || r.kind === "outgoing" : r.kind === "blocked",
  );
  const tabs: [Tab, string][] = [
    ["online", "Online"],
    ["all", "All"],
    ["pending", pending ? `Pending (${pending})` : "Pending"],
    ["blocked", "Blocked"],
  ];
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-black/20 px-4 shadow-sm">
        <span className="flex items-center gap-2 font-semibold">
          <Users className="size-5 text-muted-foreground" /> Friends
        </span>
        <div className="flex gap-1" role="tablist">
          {tabs.map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("rounded px-2 py-0.5 text-sm", tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}
            >
              {label}
            </button>
          ))}
          <button
            role="tab"
            aria-selected={tab === "add"}
            onClick={() => setTab("add")}
            className={cn("rounded px-2 py-0.5 text-sm font-medium", tab === "add" ? "text-online" : "bg-online text-white")}
          >
            Add Friend
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === "add" ? (
          <AddFriend handle={me?.handle} />
        ) : (
          <>
            <div className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {tabs.find(([t]) => t === tab)![1].replace(/ \(.*/, "")} — {shown.length}
            </div>
            <div className="divide-y divide-border" data-testid="friend-list">
              {shown.map((r) => (
                <FriendRow key={r.person.id} r={r} online={!!online[r.person.id]} />
              ))}
            </div>
            {shown.length === 0 && (
              <p className="py-10 text-center text-muted-foreground">
                {tab === "online" ? "Nobody's around right now." : tab === "pending" ? "No friend requests." : tab === "blocked" ? "You haven't blocked anyone." : "No friends yet. Add some!"}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function FriendRow({ r, online }: { r: Relationship; online: boolean }) {
  const navigate = useNavigate();
  const p = r.person;
  const sub =
    r.kind === "incoming" ? "Incoming friend request" : r.kind === "outgoing" ? "Outgoing friend request" : r.kind === "blocked" ? "Blocked" : online ? "Online" : "Offline";
  const message = () =>
    attempt(async () => {
      const c = await openDm(p.id);
      void navigate({ to: "/home/$channelId", params: { channelId: c.id } });
    });
  const icon = (label: string, onClick: () => void, children: React.ReactNode, danger = false) => (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("grid size-9 place-items-center rounded-full bg-sidebar text-muted-foreground", danger ? "hover:text-destructive" : "hover:text-foreground")}
    >
      {children}
    </button>
  );
  return (
    <div className="group flex items-center gap-3 py-2.5" data-testid="friend-row">
      <PersonAvatar person={p} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">
          {p.displayName} <span className="text-sm text-muted-foreground opacity-0 group-hover:opacity-100">@{p.handle}</span>
        </div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
      <div className="flex gap-2">
        {r.kind === "friend" && (
          <>
            {icon(`Message ${p.displayName}`, () => void message(), <MessageCircle className="size-4" />)}
            {icon(`Remove ${p.displayName}`, () => void attempt(() => removeRelationship(p.id)), <UserX className="size-4" />, true)}
          </>
        )}
        {r.kind === "incoming" && (
          <>
            {icon(`Accept ${p.displayName}`, () => void attempt(() => acceptFriend(p.id)), <Check className="size-4 text-online" />)}
            {icon(`Ignore ${p.displayName}`, () => void attempt(() => removeRelationship(p.id)), <X className="size-4" />, true)}
          </>
        )}
        {r.kind === "outgoing" && icon(`Cancel request to ${p.displayName}`, () => void attempt(() => removeRelationship(p.id)), <X className="size-4" />, true)}
        {r.kind === "blocked" && icon(`Unblock ${p.displayName}`, () => void attempt(() => removeRelationship(p.id)), <Undo2 className="size-4" />)}
        {r.kind !== "blocked" &&
          icon(`Block ${p.displayName}`, () => void attempt(() => blockPerson(p.id), `Blocked ${p.displayName}`), <span className="text-xs font-bold">⊘</span>, true)}
      </div>
    </div>
  );
}

function AddFriend({ handle }: { handle?: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await attempt(async () => {
      await addFriend(value.trim());
      setValue("");
    }, `Friend request sent to ${value.trim()}`);
    setBusy(false);
  };
  return (
    <div className="max-w-xl space-y-2">
      <h2 className="font-semibold uppercase">Add Friend</h2>
      <p className="text-sm text-muted-foreground">
        Add people by their branchr handle. Yours is <span className="font-mono text-foreground">{handle}</span>.
      </p>
      <form onSubmit={send} className="flex gap-2 rounded-lg bg-sidebar p-2">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Their handle" aria-label="Friend's handle" className="border-0 bg-transparent" />
        <Button type="submit" disabled={busy || !value.trim()}>
          Send Friend Request
        </Button>
      </form>
    </div>
  );
}
