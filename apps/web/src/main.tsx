import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createHashHistory, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import { listenForSignIn, useBranchrId } from "@/lib/branchr-id";
import { syncHosts } from "@/lib/host-sync";
import { continueServerLogin } from "@/lib/server-login";

import { routeTree } from "./routeTree.gen";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 } },
});

// Hash history works both from file:// (Electron) and any static host.
const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}


listenForSignIn((err) => {
  if (err) return void toast.error("Couldn't sign in to branchr", { description: err.message });
  toast.success(`Signed in to branchr as ${useBranchrId.getState().account?.displayName}`);
  // If signing in was the first step of logging in to a server, finish that.
  continueServerLogin().then(
    (to) => {
      void syncHosts();
      if (!to) return;
      if (to.guildId) void router.navigate({ to: "/$guildId", params: { guildId: to.guildId } });
      else void router.navigate({ to: "/hub/$instance", params: { instance: to.instance } });
    },
    (e: Error) => toast.error("Couldn't log in to the server", { description: e.message }),
  );
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
