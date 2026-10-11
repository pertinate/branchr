import { Minus, Square, X } from "lucide-react";

import { desktop } from "@/lib/desktop";
import { useApp } from "@/stores/app";

/** Custom title bar for the frameless Electron window. */
export function TitleBar() {
  const connection = useApp((s) => s.connection);
  if (!desktop) return null;
  return (
    <div className="drag flex h-6 shrink-0 items-center justify-between pl-3 text-xs text-muted-foreground">
      <span className="font-semibold tracking-wide">
        Discord Clone
        {connection === "reconnecting" && <span className="ml-2 text-idle">reconnecting…</span>}
      </span>
      <div className="no-drag flex h-full">
        <button className="grid w-10 place-items-center hover:bg-accent" onClick={() => desktop?.window.minimize()}>
          <Minus className="size-3.5" />
        </button>
        <button className="grid w-10 place-items-center hover:bg-accent" onClick={() => desktop?.window.maximize()}>
          <Square className="size-3" />
        </button>
        <button className="grid w-10 place-items-center hover:bg-destructive hover:text-white" onClick={() => desktop?.window.close()}>
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
