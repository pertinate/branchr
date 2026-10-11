/**
 * Logging in to a server with a branchr account: get a pass for it from branchr ID and
 * trade it for a session. If we aren't signed in to branchr yet, sign in first and pick
 * this up again when that finishes (`continueServerLogin`).
 */
import type { AuthResponse, InstanceInfo } from "@app/protocol";

import { ID_URL, instancePass, startSignIn, useBranchrId } from "@/lib/branchr-id";
import { useAuth } from "@/stores/auth";

const CONTINUE_KEY = "branchr-continue";

export async function instanceInfo(base: string): Promise<InstanceInfo> {
  const r = await fetch(`${base}/api/instance`);
  if (!r.ok) throw new Error(`Can't reach ${base}`);
  return r.json();
}

/** Logs in to `base`; returns false when it went to branchr sign-in first. */
export async function loginWithBranchr(base: string): Promise<boolean> {
  const info = await instanceInfo(base);
  if (info.authMode === "local" || !info.branchrIdUrl) throw new Error("This server doesn't accept branchr accounts");
  if (info.branchrIdUrl.replace(/\/$/, "") !== ID_URL) throw new Error(`This server uses a different branchr (${info.branchrIdUrl})`);
  if (!info.instanceId) throw new Error("This server is still connecting to branchr. Try again in a moment.");
  if (!useBranchrId.getState().refreshToken) {
    localStorage.setItem(CONTINUE_KEY, base);
    await startSignIn();
    return false;
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
  useAuth.getState().setSession(base, auth.token, auth.user);
  return true;
}

/** After branchr sign-in: finish the server login that started it, if any. */
export async function continueServerLogin() {
  const base = localStorage.getItem(CONTINUE_KEY);
  if (!base) return;
  localStorage.removeItem(CONTINUE_KEY);
  await loginWithBranchr(base);
}
