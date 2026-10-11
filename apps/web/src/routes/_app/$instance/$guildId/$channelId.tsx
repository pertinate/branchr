import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { ChatView } from "@/components/chat/chat-view";
import { VoiceView } from "@/components/voice/voice-view";
import { rememberChannel } from "@/lib/last-channel";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$instance/$guildId/$channelId")({
  component: ChannelPage,
});

function ChannelPage() {
  const { instance, guildId, channelId } = Route.useParams();
  const kind = useApp((s) => s.channels[channelId]?.kind);

  useEffect(() => {
    if (kind === "text") rememberChannel(instance, guildId, channelId);
  }, [instance, guildId, channelId, kind]);

  if (!kind || kind === "category") return <Navigate to="/$instance/$guildId" params={{ instance, guildId }} replace />;
  if (kind === "voice") return <VoiceView key={channelId} guildId={guildId} channelId={channelId} />;
  return <ChatView key={channelId} guildId={guildId} channelId={channelId} />;
}
