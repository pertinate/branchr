import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";

import { EmoteCard } from "@/components/chat/emote-card";
import { GlobalDialogs } from "@/components/global-dialogs";
import { ServerRail } from "@/components/server-rail";
import { AudioRenderer } from "@/components/voice/audio-renderer";
import { syncHosts } from "@/lib/host-sync";
import { startInstances, useSessions } from "@/lib/instances";
import { startNotifications } from "@/lib/notify";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ location }) => {
    if (!useSessions.getState().sessions.length) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: AppLayout,
});

function AppLayout() {
  const loggedIn = useSessions((s) => s.sessions.length > 0);
  const navigate = Route.useNavigate();

  // Every instance stays connected (badges, notifications, voice), not just the one on screen.
  useEffect(() => {
    const stopInstances = startInstances();
    const stopNotifications = startNotifications();
    void syncHosts();
    return () => {
      stopNotifications();
      stopInstances();
    };
  }, []);

  useEffect(() => {
    if (!loggedIn) void navigate({ to: "/login", search: { redirect: undefined } });
  }, [loggedIn, navigate]);

  return (
    <div className="flex h-full">
      <ServerRail />
      <div className="flex min-w-0 flex-1">
        <Outlet />
      </div>
      <AudioRenderer />
      <EmoteCard />
      <GlobalDialogs />
    </div>
  );
}
