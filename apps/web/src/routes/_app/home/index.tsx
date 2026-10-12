import { createFileRoute } from "@tanstack/react-router";

import { FriendsPage } from "@/components/home/friends-page";

export const Route = createFileRoute("/_app/home/")({
  component: FriendsPage,
});
