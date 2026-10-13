import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { Connected, Connecting } from "@/components/connecting";
import { ChannelSidebar } from "@/components/guild/channel-sidebar";
import { useGuildHub } from "@/lib/guild-hub";
import { InstanceProvider, instance as findInstance, useActive, useInstance } from "@/lib/instances";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$guildId")({
  component: GuildLayout,
});

/** A community, on whichever hub it lives (the address names only the community). */
function GuildLayout() {
  const { guildId } = Route.useParams();
  const { id, settled } = useGuildHub(guildId);
  const inst = findInstance(id);
  // Before paint, so any click already lands on this hub.
  useLayoutEffect(() => {
    if (inst && useActive.getState().id !== inst.id) useActive.setState({ id: inst.id });
  }, [inst]);
  if (!inst) return settled ? <Navigate to="/" replace /> : <Connecting />;
  return (
    <InstanceProvider instance={inst}>
      <Connected>
        <Guild guildId={guildId} />
      </Connected>
    </InstanceProvider>
  );
}

function Guild({ guildId }: { guildId: string }) {
  const inst = useInstance();
  const exists = useApp((s) => !!s.guilds[guildId]);
  const ready = useApp((s) => s.connection === "ready");
  if (!exists) return ready ? <Navigate to="/hub/$instance" params={{ instance: inst.id }} replace /> : <Connecting />;
  return (
    <>
      <ChannelSidebar guildId={guildId} />
      <main className="flex min-w-0 flex-1 bg-background">
        <Outlet />
      </main>
    </>
  );
}
