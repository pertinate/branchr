"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-white/10 bg-[oklch(0.17_0.006_264)] p-4 pr-12 text-sm leading-relaxed">
        <code>{children}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy"
        className="absolute top-2 right-2 rounded p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
