import { Outlet, createFileRoute } from "@tanstack/react-router";

import { HomeSidebar } from "@/components/home/home-sidebar";
import { startSignIn, useBranchrId } from "@/lib/branchr-id";
import { Button } from "@/components/ui/button";
import { useSocial } from "@/lib/social";

export const Route = createFileRoute("/_app/home")({
  component: HomeLayout,
});

/** Friends and DMs live on your branchr account, so they need you signed in to it. */
function HomeLayout() {
  const account = useBranchrId((s) => s.account);
  const status = useSocial((s) => s.status);
  if (!account) {
    return (
      <div className="grid flex-1 place-items-center bg-background p-8 text-center">
        <div className="max-w-sm space-y-3">
          <h1 className="text-xl font-semibold">Friends and direct messages</h1>
          <p className="text-muted-foreground">They follow your branchr account across every host, so sign in to it first.</p>
          <Button onClick={() => void startSignIn()}>Sign in with Discord</Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <HomeSidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {status === "ready" ? <Outlet /> : <p className="m-auto text-muted-foreground">Connecting to branchr…</p>}
      </main>
    </>
  );
}
