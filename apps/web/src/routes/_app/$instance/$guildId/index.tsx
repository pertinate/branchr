import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { lastChannel } from "@/lib/last-channel";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$instance/$guildId/")({
  component: GuildIndex,
});

/** A server without a channel picked: open the last one used there, or its first. */
function GuildIndex() {
  const { instance, guildId } = Route.useParams();
  const navigate = useNavigate();
  // Every arrival here redirects, including a second one while this stays mounted (a join's
  // response can land after the gateway already opened the channel).
  const href = useRouterState({ select: (s) => s.location.href });
  const target = useApp((s) => {
    const remembered = lastChannel(instance, guildId);
    if (remembered && s.channels[remembered]?.kind === "text") return remembered;
    return Object.values(s.channels)
      .filter((c) => c.guildId === guildId && c.kind === "text")
      .sort((a, b) => a.position - b.position)[0]?.id;
  });
  useEffect(() => {
    if (target) void navigate({ to: "/$instance/$guildId/$channelId", params: { instance, guildId, channelId: target }, replace: true });
  }, [target, instance, guildId, href, navigate]);
  if (!target) return <div className="grid flex-1 place-items-center text-muted-foreground">No text channels</div>;
  return null;
}
