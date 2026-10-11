import { Navigate, createFileRoute } from "@tanstack/react-router";

import { useActive, useInstanceList } from "@/lib/instances";

export const Route = createFileRoute("/_app/")({
  component: Home,
});

/** Opens the instance in use (or the first one). */
function Home() {
  const ids = useInstanceList((s) => s.ids);
  const active = useActive((s) => s.id);
  const target = active && ids.includes(active) ? active : ids[0];
  if (!target) return null;
  return <Navigate to="/$instance" params={{ instance: target }} replace />;
}
