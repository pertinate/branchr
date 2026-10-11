import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { InstanceProvider, instance as findInstance, useActive, useInstanceList } from "@/lib/instances";
import { useApp } from "@/stores/app";

export const Route = createFileRoute("/_app/$instance")({
  component: InstanceLayout,
});

/** Everything under here reads this instance's stores, and handlers act on it. */
function InstanceLayout() {
  const { instance: id } = Route.useParams();
  // Re-render when instances come or go (e.g. logging out of this one).
  useInstanceList((s) => s.ids);
  const inst = findInstance(id);
  // Before paint, so any click already lands on this instance.
  useLayoutEffect(() => {
    if (inst && useActive.getState().id !== inst.id) useActive.setState({ id: inst.id });
  }, [inst]);
  if (!inst) return <Navigate to="/" replace />;
  return (
    <InstanceProvider instance={inst}>
      <Connected>
        <Outlet />
      </Connected>
    </InstanceProvider>
  );
}

function Connected({ children }: { children: React.ReactNode }) {
  const ready = useApp((s) => s.connection === "ready" || s.me !== null);
  if (ready) return <>{children}</>;
  return (
    <div className="grid flex-1 place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="size-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        Connecting…
      </div>
    </div>
  );
}
