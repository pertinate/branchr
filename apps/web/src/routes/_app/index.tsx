import { Navigate, createFileRoute, useRouterState } from "@tanstack/react-router";

import { useActive, useInstanceList } from "@/lib/instances";

export const Route = createFileRoute("/_app/")({
  component: Home,
});

/** Opens the instance in use (or the first one). */
function Home() {
  const ids = useInstanceList((s) => s.ids);
  const active = useActive((s) => s.id);
  const target = active && ids.includes(active) ? active : ids[0];
  // Only while this is still where we're headed (see $instance/index).
  const here = useRouterState({ select: (s) => s.location.pathname === "/" });
  if (!target || !here) return null;
  return <Navigate to="/hub/$instance" params={{ instance: target }} replace />;
}
