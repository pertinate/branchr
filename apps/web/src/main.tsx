import "./index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createHashHistory, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";

import { listenForSignIn, useBranchrId } from "@/lib/branchr-id";

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
  if (err) toast.error("Couldn't sign in to branchr", { description: err.message });
  else toast.success(`Signed in to branchr as ${useBranchrId.getState().account?.displayName}`);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
