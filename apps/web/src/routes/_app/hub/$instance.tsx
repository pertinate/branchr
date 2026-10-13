import { Navigate, Outlet, createFileRoute } from "@tanstack/react-router";
import { useLayoutEffect } from "react";

import { Connected } from "@/components/connecting";
import { InstanceProvider, instance as findInstance, useActive, useInstanceList } from "@/lib/instances";

export const Route = createFileRoute("/_app/hub/$instance")({
  component: InstanceLayout,
});

/** A hub's own page (no communities yet): everything here reads its stores. */
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
