import { createFileRoute } from "@tanstack/react-router";

import { DmView } from "@/components/home/dm-view";

export const Route = createFileRoute("/_app/home/$channelId")({
  component: DmRoute,
});

function DmRoute() {
  const { channelId } = Route.useParams();
  return <DmView key={channelId} channelId={channelId} />;
}
