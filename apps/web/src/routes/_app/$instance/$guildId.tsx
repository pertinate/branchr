import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";

import { ChannelSidebar } from "@/components/guild/channel-sidebar";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$instance/$guildId")({
  component: GuildLayout,
});

function GuildLayout() {
  const { instance, guildId } = Route.useParams();
  const exists = useApp((s) => !!s.guilds[guildId]);
  if (!exists) return <Navigate to="/$instance" params={{ instance }} replace />;
  return (
    <>
      <ChannelSidebar guildId={guildId} />
      <main className="flex min-w-0 flex-1 bg-background">
        <Outlet />
      </main>
    </>
  );
}
