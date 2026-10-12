import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { type ExploreTab, ExplorePage } from "@/components/explore-page";

export const Route = createFileRoute("/_app/explore")({
  validateSearch: (s: Record<string, unknown>): { tab?: ExploreTab } => ({
    tab: s.tab === "discover" || s.tab === "yours" ? s.tab : undefined,
  }),
  component: Explore,
});

function Explore() {
  const { tab = "yours" } = Route.useSearch();
  const navigate = useNavigate();
  return <ExplorePage tab={tab} onTab={(t) => void navigate({ to: "/explore", search: { tab: t }, replace: true })} />;
}
