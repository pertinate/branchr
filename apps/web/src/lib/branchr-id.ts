/**
 * Signing in to branchr ID (the central account service) with Discord.
 *
 * OAuth 2 authorization code + PKCE. The desktop app opens the system browser and gets the
 * result back through a `branchr://auth/callback` link; the web app redirects in place and
 * reads `?code&state` when it loads again.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { desktop } from "@/lib/desktop";

/** `VITE_BRANCHR_ID_URL` overrides; dev builds default to a local branchr ID. */
export const ID_URL = ((import.meta.env.VITE_BRANCHR_ID_URL as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:8070" : "https://branchr.us")).replace(
  /\/$/,
  "",
);
const DESKTOP_REDIRECT = "branchr://auth/callback";
const PENDING_KEY = "branchr-id-pending";

export interface BranchrAccount {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  account: BranchrAccount;
}

interface IdState {
  account: BranchrAccount | null;
  refreshToken: string | null;
}

export const useBranchrId = create<IdState>()(persist((): IdState => ({ account: null, refreshToken: null }), { name: "branchr-id" }));

// Another tab or window rotated the refresh token (or signed in or out): use what it saved.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === "branchr-id") void useBranchrId.persist.rehydrate();
  });
}

// Access tokens live only in memory; they're short-lived and minted from the refresh token.
let access: { token: string; expires: number } | null = null;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function random(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Where branchr ID sends the browser back to. */
function redirectUri(): string {
  // The app's own page: `/` in development, `/app/` where a hub serves it.
  return desktop ? DESKTOP_REDIRECT : `${location.origin}${location.pathname}`;
}

/** Opens Discord sign-in. Finishes in `completeSignIn` when the redirect comes back. */
export async function startSignIn() {
  const verifier = random();
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = random();
  const redirect = redirectUri();
  localStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, redirect }));
  const url = new URL(`${ID_URL}/authorize`);
  url.search = new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state }).toString();
  // In the desktop app this opens the system browser (window.open goes to openExternal).
  if (desktop) window.open(url.toString(), "_blank");
  else location.assign(url.toString());
}

function save(t: TokenResponse) {
  access = { token: t.access_token, expires: Date.now() + (t.expires_in - 30) * 1000 };
  useBranchrId.setState({ account: t.account, refreshToken: t.refresh_token });
}

async function post(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${ID_URL}${path}`, { method: "POST", body: new URLSearchParams(form) });
}

async function errorOf(r: Response): Promise<string> {
  try {
    const e = await r.json();
    return e.error_description || e.error || `sign-in failed (${r.status})`;
  } catch {
    return `sign-in failed (${r.status})`;
  }
}

/** Finishes a sign-in from the redirect's query. Returns false if it wasn't one of ours. */
export async function completeSignIn(params: URLSearchParams): Promise<boolean> {
  let pending: { verifier: string; state: string; redirect: string } | null = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
  } catch {
    /* corrupt; treat as none */
  }
  if (!pending || params.get("state") !== pending.state) return false;
  localStorage.removeItem(PENDING_KEY);
  const error = params.get("error");
  if (error) throw new Error(error === "access_denied" ? "Sign-in was cancelled" : error);
  const code = params.get("code");
  if (!code) throw new Error("sign-in failed: no code");
  const r = await post("/token", { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: pending.redirect });
  if (!r.ok) throw new Error(await errorOf(r));
  save(await r.json());
  return true;
}

// One refresh at a time: branchr ID treats a reused refresh token as stolen.
let refreshing: Promise<string | null> | null = null;

/** A valid access token, refreshing if needed; null when signed out. */
export function accessToken(): Promise<string | null> {
  if (access && access.expires > Date.now()) return Promise.resolve(access.token);
  refreshing ??= (async () => {
    const rt = useBranchrId.getState().refreshToken;
    if (!rt) return null;
    const r = await post("/token", { grant_type: "refresh_token", refresh_token: rt });
    if (r.status === 400) {
      // Revoked or expired: signed out.
      useBranchrId.setState({ account: null, refreshToken: null });
      return null;
    }
    if (!r.ok) throw new Error(await errorOf(r));
    const t: TokenResponse = await r.json();
    save(t);
    return t.access_token;
  })().finally(() => (refreshing = null));
  return refreshing;
}

export async function signOut() {
  const rt = useBranchrId.getState().refreshToken;
  access = null;
  useBranchrId.setState({ account: null, refreshToken: null });
  if (rt) await post("/logout", { refresh_token: rt }).catch(() => {});
}

/**
 * Picks up sign-in results: the desktop app's `branchr://` links, or this page's own URL
 * after a web redirect. Call once at startup; `onResult` reports success or the error.
 */
export function listenForSignIn(onResult: (err: Error | null) => void) {
  const finish = (params: URLSearchParams) =>
    completeSignIn(params).then(
      (ours) => ours && onResult(null),
      (e: Error) => onResult(e),
    );
  if (desktop?.auth) {
    const handle = (url: string) => void finish(new URL(url).searchParams);
    desktop.auth.onCallback(handle);
    void desktop.auth.pending().then((url) => url && handle(url));
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.has("state") && (params.has("code") || params.has("error"))) {
    // Drop the code from the address bar (and history) right away.
    history.replaceState(null, "", location.pathname + location.hash);
    void finish(params);
  }
}

/** A short-lived pass to log in to one server with this branchr account. */
export async function instancePass(instanceId: string): Promise<string> {
  const at = await accessToken();
  if (!at) throw new Error("Sign in to branchr first");
  const r = await fetch(`${ID_URL}/instances/${encodeURIComponent(instanceId)}/token`, { method: "POST", headers: { authorization: `Bearer ${at}` } });
  if (!r.ok) throw new Error(await errorOf(r));
  return ((await r.json()) as { token: string }).token;
}

/** Claims a self-hosted server with the code it showed its owner. Returns its name. */
export async function claimServer(code: string): Promise<string> {
  const at = await accessToken();
  if (!at) throw new Error("Sign in to branchr first");
  const r = await fetch(`${ID_URL}/claims`, {
    method: "POST",
    headers: { authorization: `Bearer ${at}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) throw new Error(await errorOf(r));
  return ((await r.json()) as { name: string }).name;
}

/** A server (host) the signed-in account has claimed. */
export interface OwnedHost {
  instanceId: string;
  name: string;
  publicUrl: string;
}

export async function ownedHosts(): Promise<OwnedHost[]> {
  const at = await accessToken();
  if (!at) return [];
  const r = await fetch(`${ID_URL}/me/owned`, { headers: { authorization: `Bearer ${at}` } });
  if (!r.ok) throw new Error(await errorOf(r));
  return r.json();
}
