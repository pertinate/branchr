import { useApp } from "@/stores/app";

export function Connecting() {
  return (
    <div className="grid flex-1 place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="size-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        Connecting…
      </div>
    </div>
  );
}

/** Its children once this hub has said hello (or has before). */
export function Connected({ children }: { children: React.ReactNode }) {
  const ready = useApp((s) => s.connection === "ready" || s.me !== null);
  return ready ? <>{children}</> : <Connecting />;
}
