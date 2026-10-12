import { Navigate, createFileRoute, useRouterState } from "@tanstack/react-router";

import { useInstance } from "@/lib/instances";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$instance/")({
  component: InstanceHome,
});

function InstanceHome() {
  const { instance } = Route.useParams();
  const first = useApp((s) => s.guildOrder[0]);
  const host = useInstance().url.replace(/^https?:\/\//, "");
  // Still where we're headed: while another page loads (after a click elsewhere), this one
  // stays on screen and mustn't redirect over it.
  const here = useRouterState({ select: (s) => s.location.pathname === `/${instance}` });
  if (first && here) return <Navigate to="/$instance/$guildId" params={{ instance, guildId: first }} replace />;
  return (
    <div className="grid flex-1 place-items-center bg-background">
      <div className="max-w-sm text-center text-muted-foreground">
        <h2 className="mb-2 text-xl font-semibold text-foreground">No leaflets yet</h2>
        Create a leaflet on <span className="font-medium text-foreground">{host}</span> or join one with an invite using the{" "}
        <span className="font-bold text-online">+</span> button on the left.
      </div>
    </div>
  );
}
