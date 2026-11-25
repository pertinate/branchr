"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

interface Hub {
  instanceId: string;
  name: string;
  publicUrl: string;
  lastSeen: number | null;
}

/** The hubs you own, and claiming another. */
export function Hubs({ accessToken }: { accessToken: string }) {
  const [hubs, setHubs] = useState<Hub[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (method: string, path: string, body?: unknown) => {
      const r = await fetch(path, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401) throw new Error("Reload the page to keep going.");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error_description ?? `Something went wrong (${r.status})`);
      return r;
    },
    [accessToken],
  );

  const refresh = useCallback(async () => setHubs(await (await call("GET", "/me/owned")).json()), [call]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="text-lg font-semibold">Your hubs</h2>
      {hubs?.length === 0 && <p className="text-sm text-muted-foreground">None yet. A hub prints a claim code when it first starts.</p>}
      <ul className="space-y-2">
        {hubs?.map((h) => (
          <li key={h.instanceId} className="flex items-center gap-4 rounded-lg border border-white/5 bg-card p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{h.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {h.publicUrl || "No public address"} · {h.lastSeen ? `last seen ${new Date(h.lastSeen).toLocaleString()}` : "not seen yet"}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (confirm(`Release ${h.name}? It will show a new claim code.`)) void run(() => call("DELETE", `/instances/${h.instanceId}/claim`));
              }}
            >
              Release
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call("POST", "/claims", { code });
            setCode("");
          });
        }}
      >
        <input
          aria-label="Claim code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          required
          className="h-9 w-40 rounded-md border border-white/10 bg-transparent px-3 text-sm uppercase"
        />
        <Button type="submit" disabled={busy}>
          Claim a hub
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
