import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { TitleBar } from "@/components/title-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col bg-rail text-foreground">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <Toaster position="bottom-right" theme="dark" />
    </TooltipProvider>
  ),
});
