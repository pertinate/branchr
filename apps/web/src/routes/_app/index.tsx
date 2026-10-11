import { Navigate, createFileRoute } from "@tanstack/react-router";

import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/")({
  component: Home,
});

function Home() {
  const first = useApp((s) => s.guildOrder[0]);
  if (first) return <Navigate to="/$guildId" params={{ guildId: first }} replace />;
  return (
    <div className="grid flex-1 place-items-center bg-background">
      <div className="max-w-sm text-center text-muted-foreground">
        <h2 className="mb-2 text-xl font-semibold text-foreground">No servers yet</h2>
        Create a server or join one with an invite using the <span className="font-bold text-online">+</span> button on the left.
      </div>
    </div>
  );
}
