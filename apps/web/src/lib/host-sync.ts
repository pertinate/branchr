/**
 * branchr ID remembers which hosts you use with your branchr account, so signing in on a
 * new device reconnects to all of them. Only hosts that take branchr accounts are kept
 * (password-only hosts can't be logged in to without you).
 */
import { ID_URL, accessToken, useBranchrId } from "@/lib/branchr-id";
import { normalizeUrl, useSessions } from "@/lib/instances";
import { loginWithBranchr } from "@/lib/server-login";

async function call(method: "GET" | "PUT" | "DELETE", url?: string) {
  const at = await accessToken();
  if (!at) return null;
  const r = await fetch(`${ID_URL}/me/instances`, {
    method,
    headers: { authorization: `Bearer ${at}`, ...(url ? { "content-type": "application/json" } : {}) },
    body: url ? JSON.stringify({ url }) : undefined,
  });
  return r.ok ? r : null;
}

/** Remembers a host logged in to with the branchr account. Best effort. */
export function rememberHost(url: string) {
  void call("PUT", normalizeUrl(url)).catch(() => {});
}

/** Forgets a host (you logged out of it on purpose). Best effort. */
export function forgetHost(url: string) {
  void call("DELETE", normalizeUrl(url)).catch(() => {});
}

let syncing: Promise<void> | null = null;

/** Logs in, with the branchr account, to remembered hosts this device isn't on yet. */
export function syncHosts(): Promise<void> {
  if (!useBranchrId.getState().refreshToken) return Promise.resolve();
  syncing ??= (async () => {
    try {
      const r = await call("GET");
      if (!r) return;
      const hosts = (await r.json()) as { url: string }[];
      const have = new Set(useSessions.getState().sessions.map((s) => normalizeUrl(s.url)));
      // One at a time: each asks branchr ID for a pass; a host that's down just waits for next time.
      for (const h of hosts) {
        if (have.has(normalizeUrl(h.url))) continue;
        await loginWithBranchr(h.url, undefined, { background: true }).catch((e) => console.warn(`reconnecting to ${h.url}:`, (e as Error).message));
      }
    } catch (e) {
      console.warn("syncing hosts:", (e as Error).message);
    }
  })().finally(() => (syncing = null));
  return syncing;
}
