import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, LogOut, Settings } from "lucide-react";

import { guildInitials } from "@/components/guild/guild-badge";
import { useHostOwner } from "@/components/host-admin-dialog";
import { MentionBadge } from "@/components/mention-badge";
import { guildPings, guildUnread } from "@/components/rail-list";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/actions";
import { forgetHost } from "@/lib/host-sync";
import { type Instance, InstanceProvider, hostOf, instance, useInstance, useInstanceList } from "@/lib/instances";
import { useMediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useDialogs } from "@/stores/ui";

/** Every server you're in, by the host it lives on, with each host's own actions. */
export function YourServers({ query }: { query: string }) {
  const ids = useInstanceList((s) => s.ids);
  return (
    <div className="flex flex-col gap-8 px-8 py-6">
      {ids.map((id) => {
        const inst = instance(id);
        return inst ? (
          <InstanceProvider key={id} instance={inst}>
            <HostSection query={query.toLowerCase()} />
          </InstanceProvider>
        ) : null;
      })}
    </div>
  );
}

function HostSection({ query }: { query: string }) {
  const inst = useInstance();
  const host = hostOf(inst.url);
  const connection = useApp((s) => s.connection);
  const me = useApp((s) => s.me);
  const all = useApp((s) => s.guildOrder);
  const guilds = useApp((s) => s.guilds);
  const order = query ? all.filter((g) => guilds[g]?.name.toLowerCase().includes(query)) : all;
  return (
    <section data-testid="host-section" data-instance={inst.id} aria-label={host} className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3 border-b border-border pb-2">
        <span className={cn("size-2 shrink-0 rounded-full", connection === "ready" ? "bg-online" : "bg-idle")} title={connection === "ready" ? "Connected" : "Connecting…"} />
        <h2 className="text-lg font-semibold">{host}</h2>
        {me && <span className="text-sm text-muted-foreground">as @{me.username}</span>}
        <div className="flex-1" />
        <HostActions inst={inst} />
      </header>
      {order.length === 0 ? (
        <p className="text-sm text-muted-foreground">{query ? "No communities here match." : "No communities on this hub yet."}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {order.map((gid) => (
            <GuildCard key={gid} guildId={gid} />
          ))}
        </div>
      )}
    </section>
  );
}

function HostActions({ inst }: { inst: Instance }) {
  const owner = useHostOwner(inst);
  const navigate = useNavigate();
  const host = hostOf(inst.url);
  return (
    <div className="flex gap-2">
      {owner && (
        <Button size="sm" variant="secondary" onClick={() => useDialogs.getState().open({ instanceId: inst.id, kind: "host-admin" })}>
          <Settings /> Manage Hub
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={() => void copy(inst.url, "Copied address")}>
        <Copy /> Copy Address
      </Button>
      <Button
        size="sm"
        variant="destructive"
        aria-label={`Log Out of ${host}`}
        onClick={() => {
          if (!confirm(`Log out of ${host}? Your other hubs stay connected.`)) return;
          forgetHost(inst.url);
          void inst.api("POST", "/auth/logout").catch(() => {});
          inst.auth.getState().logout();
          void navigate({ to: "/explore", search: { tab: "yours" } });
        }}
      >
        <LogOut /> Log Out
      </Button>
    </div>
  );
}

function GuildCard({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const guild = useApp((s) => s.guilds[guildId]);
  const icon = useMediaUrl(guild?.iconUrl);
  const unread = useApp((s) => guildUnread(s, guildId));
  const pings = useApp((s) => guildPings(s, guildId));
  if (!guild) return null;
  return (
    <Link
      to="/$instance/$guildId"
      params={{ instance: inst.id, guildId }}
      data-testid="guild-card"
      className="flex items-center gap-3 rounded-lg bg-sidebar p-3 transition-colors hover:bg-accent"
    >
      <span className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl bg-background text-sm font-semibold">
        {icon ? <img src={icon} alt="" className="size-full object-cover" /> : guildInitials(guild.name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate font-semibold", !unread && "text-muted-foreground")}>{guild.name}</span>
      </span>
      {pings > 0 && <MentionBadge count={pings} />}
    </Link>
  );
}
