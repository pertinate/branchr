import { Navigate, createFileRoute } from "@tanstack/react-router";

import { lastChannel } from "@/lib/last-channel";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$instance/$guildId/")({
  component: GuildIndex,
});

function GuildIndex() {
  const { instance, guildId } = Route.useParams();
  const target = useApp((s) => {
    const remembered = lastChannel(instance, guildId);
    if (remembered && s.channels[remembered]?.kind === "text") return remembered;
    return Object.values(s.channels)
      .filter((c) => c.guildId === guildId && c.kind === "text")
      .sort((a, b) => a.position - b.position)[0]?.id;
  });
  if (!target) return <div className="grid flex-1 place-items-center text-muted-foreground">No text channels</div>;
  return <Navigate to="/$instance/$guildId/$channelId" params={{ instance, guildId, channelId: target }} replace />;
}
