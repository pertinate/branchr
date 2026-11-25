"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

interface Hub {
  instanceId: string;
  name: string;
  publicUrl: string;
  lastSeen: number | null;
  relayId: string | null;
}

interface Relay {
  relayId: string;
  name: string;
  web: string | null;
  lastSeen: number | null;
}

const seen = (at: number | null) => (at ? `last seen ${new Date(at).toLocaleString()}` : "not seen yet");

/** The hubs and relays you own, claiming more, and which relay carries each hub. */
export function Hubs({ accessToken }: { accessToken: string }) {
  const [hubs, setHubs] = useState<Hub[] | null>(null);
  const [relays, setRelays] = useState<Relay[] | null>(null);
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

  const refresh = useCallback(async () => {
    const [h, r] = await Promise.all([call("GET", "/me/owned"), call("GET", "/me/relays")]);
    setHubs(await h.json());
    setRelays(await r.json());
  }, [call]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  const release = (name: string, path: string, effect: string) => {
    if (confirm(`Release ${name}? ${effect}`)) void run(() => call("DELETE", path));
  };

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Your hubs</h2>
        {hubs?.length === 0 && <p className="text-sm text-muted-foreground">None yet. A hub prints a claim code when it first starts.</p>}
        <ul className="space-y-2">
          {hubs?.map((h) => {
            const relay = relays?.find((r) => r.relayId === h.relayId);
            const address = relay?.web ? `${relay.web}/h/${h.instanceId}` : h.publicUrl;
            return (
              <li key={h.instanceId} className="space-y-3 rounded-lg border border-white/5 bg-card p-4">
                <div className="flex items-center gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{h.name}</p>
                    <p className="truncate text-sm text-muted-foreground">{seen(h.lastSeen)}</p>
                    <p className="text-sm break-all text-muted-foreground">{address || "No public address"}</p>
                  </div>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => release(h.name, `/instances/${h.instanceId}/claim`, "It will show a new claim code.")}>
                    Release
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  Relay
                  <select
                    aria-label={`Relay for ${h.name}`}
                    className="h-8 rounded-md border border-white/10 bg-card px-2"
                    value={h.relayId ?? ""}
                    disabled={busy}
                    onChange={(e) => void run(() => call("PUT", `/instances/${h.instanceId}/relay`, { relayId: e.target.value || null }))}
                  >
                    <option value="">None</option>
                    {relays?.map((r) => (
                      <option key={r.relayId} value={r.relayId}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
        <ClaimForm what="hub" busy={busy} onClaim={(code) => run(() => call("POST", "/claims", { code }))} />
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Your relays</h2>
        {relays?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            A relay is a server with a public address that carries your hubs, so they need none. It prints a claim code when it first starts.
          </p>
        )}
        <ul className="space-y-2">
          {relays?.map((r) => (
            <li key={r.relayId} className="flex items-center gap-4 rounded-lg border border-white/5 bg-card p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{r.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {r.web ?? "Hasn't reported in"} · {seen(r.lastSeen)}
                </p>
              </div>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => release(r.name, `/relays/${r.relayId}/claim`, "Its hubs will be unlinked.")}>
                Release
              </Button>
            </li>
          ))}
        </ul>
        <ClaimForm what="relay" busy={busy} onClaim={(code) => run(() => call("POST", "/relays/claims", { code }))} />
      </section>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function ClaimForm({ what, busy, onClaim }: { what: "hub" | "relay"; busy: boolean; onClaim: (code: string) => Promise<boolean> }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onClaim(code).then((ok) => ok && setCode(""));
      }}
    >
      <input
        aria-label={`${what === "hub" ? "Hub" : "Relay"} claim code`}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="XXXX-XXXX"
        required
        className="h-9 w-40 rounded-md border border-white/10 bg-transparent px-3 text-sm uppercase"
      />
      <Button type="submit" disabled={busy}>
        Claim a {what}
      </Button>
    </form>
  );
}
