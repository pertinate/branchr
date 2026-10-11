/**
 * Logging in to a server with a branchr account: get a pass for it from branchr ID and
 * trade it for a session. If we aren't signed in to branchr yet, sign in first and pick
 * this up again when that finishes (`continueServerLogin`).
 */
import type { AuthResponse, InstanceInfo, ReadyGuild } from "@app/protocol";

import { ID_URL, instancePass, startSignIn, useBranchrId } from "@/lib/branchr-id";
import { rememberHost } from "@/lib/host-sync";
import { instance, instanceKey, normalizeUrl, useSessions } from "@/lib/instances";
import { useAuth } from "@/stores/auth";

const CONTINUE_KEY = "branchr-continue";

export async function instanceInfo(base: string): Promise<InstanceInfo> {
  const r = await fetch(`${base}/api/instance`);
  if (!r.ok) throw new Error(`Can't reach ${base}`);
  return r.json();
}

/** Where to go after logging in: the instance, or a server just joined there. */
export interface Landing {
  instance: string;
  guildId?: string;
}

/**
 * Finishes a login to `base` (now saved as an instance): joins `invite` there if given.
 * The instance connects in the background; the join uses its API directly.
 */
export async function landAfterLogin(base: string, invite?: string): Promise<Landing> {
  const id = instanceKey(normalizeUrl(base));
  const inst = instance(id);
  if (!invite || !inst) return { instance: id };
  const g = await inst.api<ReadyGuild>("POST", `/invites/${encodeURIComponent(invite)}`);
  inst.app.getState().apply({ t: "GUILD_CREATE", d: g });
  return { instance: id, guildId: g.guild.id };
}

/**
 * Logs in to `base`; returns null when it went to branchr sign-in first (see
 * `continueServerLogin`). `background` logins (reconnecting remembered hosts) don't switch
 * to the host.
 */
export async function loginWithBranchr(base: string, invite?: string, opts: { background?: boolean } = {}): Promise<Landing | null> {
  const info = await instanceInfo(base);
  if (info.authMode === "local" || !info.branchrIdUrl) throw new Error("This server doesn't accept branchr accounts");
  if (info.branchrIdUrl.replace(/\/$/, "") !== ID_URL) throw new Error(`This server uses a different branchr (${info.branchrIdUrl})`);
  if (!info.instanceId) throw new Error("This server is still connecting to branchr. Try again in a moment.");
  if (!useBranchrId.getState().refreshToken) {
    if (opts.background) return null;
    localStorage.setItem(CONTINUE_KEY, JSON.stringify({ base, invite }));
    await startSignIn();
    return null;
  }
  const pass = await instancePass(info.instanceId);
  const r = await fetch(`${base}/api/auth/federated`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: pass }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(r.status === 403 ? "This server isn't taking new members" : (body.error ?? `login failed (${r.status})`));
  }
  const auth = (await r.json()) as AuthResponse;
  if (opts.background) useSessions.getState().add(base, auth.token, auth.user);
  else useAuth.getState().setSession(base, auth.token, auth.user);
  rememberHost(base);
  return landAfterLogin(base, invite);
}

/** After branchr sign-in: finish the server login that started it, if any. */
export async function continueServerLogin(): Promise<Landing | null> {
  const raw = localStorage.getItem(CONTINUE_KEY);
  if (!raw) return null;
  localStorage.removeItem(CONTINUE_KEY);
  let pending: { base: string; invite?: string };
  try {
    pending = JSON.parse(raw);
  } catch {
    pending = { base: raw };
  }
  return loginWithBranchr(pending.base, pending.invite);
}

/** Ties the logged-in user on the current server to the signed-in branchr account. */
export async function linkToBranchr() {
  const { serverUrl, token } = useAuth.getState();
  const info = await instanceInfo(serverUrl);
  if (!info.instanceId) throw new Error("This server isn't connected to branchr");
  const pass = await instancePass(info.instanceId);
  const r = await fetch(`${serverUrl}/api/auth/link`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ token: pass }),
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `linking failed (${r.status})`);
  rememberHost(serverUrl);
}
