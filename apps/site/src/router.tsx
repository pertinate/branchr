import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { Layout } from "@/layout";
import { FeaturesPage } from "@/pages/features";
import { HomePage } from "@/pages/home";
import { HowItWorksPage } from "@/pages/how-it-works";
import { PerformancePage } from "@/pages/performance";
import { SelfHostPage } from "@/pages/self-host";

const root = createRootRoute({ component: Layout });
const home = createRoute({ getParentRoute: () => root, path: "/", component: HomePage });
const features = createRoute({ getParentRoute: () => root, path: "/features", component: FeaturesPage });
const performance = createRoute({ getParentRoute: () => root, path: "/performance", component: PerformancePage });
const howItWorks = createRoute({ getParentRoute: () => root, path: "/how-it-works", component: HowItWorksPage });
const selfHost = createRoute({ getParentRoute: () => root, path: "/self-host", component: SelfHostPage });

export const router = createRouter({
  routeTree: root.addChildren([home, features, performance, howItWorks, selfHost]),
  scrollRestoration: true,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
