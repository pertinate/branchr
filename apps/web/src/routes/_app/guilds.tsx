import { createFileRoute } from "@tanstack/react-router";

import { MyGuildsPage } from "@/components/my-guilds-page";

export const Route = createFileRoute("/_app/guilds")({
  component: MyGuildsPage,
});
