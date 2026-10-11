import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";

import { EmoteCard } from "@/components/chat/emote-card";
import { AudioRenderer } from "@/components/voice/audio-renderer";
import { ServerRail } from "@/components/server-rail";
import { gateway } from "@/lib/gateway";
import { startNotifications } from "@/lib/notify";
import { useApp } from "@/stores/app";
import { useAuth } from "@/stores/auth";
import { useVoice } from "@/stores/voice";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    if (!useAuth.getState().token) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: AppLayout,
});

function AppLayout() {
  const token = useAuth((s) => s.token);
  const navigate = Route.useNavigate();
  const ready = useApp((s) => s.connection === "ready" || s.me !== null);

  useEffect(() => {
    if (!token) {
      useVoice.getState().leave();
      gateway.stop();
      void navigate({ to: "/login", search: { redirect: undefined } });
      return;
    }
    gateway.start();
    const stopNotifications = startNotifications();
    return () => {
      stopNotifications();
      gateway.stop();
    };
  }, [token, navigate]);

  if (!ready) {
    return (
      <div className="grid h-full place-items-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="size-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          Connecting…
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <ServerRail />
      <div className="flex min-w-0 flex-1">
        <Outlet />
      </div>
      <AudioRenderer />
      <EmoteCard />
    </div>
  );
}
