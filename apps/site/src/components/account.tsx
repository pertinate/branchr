"use client";

import { useEffect, useState } from "react";

import { Hubs } from "@/components/hubs";
import { Button } from "@/components/ui/button";

// The web app's own storage (it's on this origin), so one sign-in covers both.
const STORE = "branchr-id";
const PENDING = "branchr-site-pending";

interface Signed {
  account: { id: string; displayName: string; avatarUrl: string | null };
  refreshToken: string;
}

function stored(): Signed | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? "null")?.state;
    return s?.account && s.refreshToken ? s : null;
  } catch {
    return null;
  }
}

const save = (state: Signed | { account: null; refreshToken: null }) => localStorage.setItem(STORE, JSON.stringify({ state, version: 0 }));

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const redirectUri = () => `${location.origin}/account`;

async function signIn() {
  const verifier = random();
  const state = random();
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({ redirect_uri: redirectUri(), code_challenge: challenge, code_challenge_method: "S256", state });
  location.assign(`/authorize?${q}`);
}

/** Finishes a sign-in if this load is its return. */
async function complete(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? "null") as { verifier: string; state: string } | null;
  if (!pending || q.get("state") !== pending.state) return;
  sessionStorage.removeItem(PENDING);
  history.replaceState(null, "", location.pathname);
  if (q.get("error")) throw new Error(q.get("error") === "access_denied" ? "Sign-in was cancelled" : q.get("error")!);
  const r = await fetch("/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: q.get("code") ?? "", code_verifier: pending.verifier, redirect_uri: redirectUri() }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error_description ?? `Sign-in failed (${r.status})`);
  save({ account: body.account, refreshToken: body.refresh_token });
}

/** Trades the saved sign-in for a fresh access token, which proves it still works.
 *  Null (and forgotten) if the server no longer accepts it. */
async function renew(): Promise<{ signed: Signed; accessToken: string } | null> {
  const saved = stored();
  if (!saved) return null;
  const r = await fetch("/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken }) });
  const body = await r.json().catch(() => ({}));
  if (r.status === 400 && body.error === "invalid_grant") {
    save({ account: null, refreshToken: null });
    return null;
  }
  if (!r.ok) throw new Error(body.error_description ?? `Couldn't check your sign-in (${r.status})`);
  const signed = { account: body.account, refreshToken: body.refresh_token };
  save(signed);
  return { signed, accessToken: body.access_token };
}

type State = { status: "checking" } | { status: "out" } | { status: "in"; signed: Signed; accessToken: string } | { status: "error" };

// Shared while in flight, however often React runs the effect: a sign-in code works once.
let loading: Promise<State> | null = null;
let loadError: string | null = null;

function load(): Promise<State> {
  return (loading ??= (async (): Promise<State> => {
    loadError = null;
    try {
      await complete().catch((e: Error) => {
        loadError = e.message;
      });
      const r = await renew();
      return r ? { status: "in", ...r } : { status: "out" };
    } catch (e) {
      loadError = (e as Error).message;
      return { status: "error" };
    }
  })().finally(() => (loading = null)));
}

export function Account() {
  const [state, setState] = useState<State>({ status: "checking" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load().then((s) => {
      setState(s);
      setError(loadError);
    });
  }, []);

  async function signOut() {
    const token = stored()?.refreshToken;
    if (token) await fetch("/logout", { method: "POST", body: new URLSearchParams({ refresh_token: token }) }).catch(() => {});
    save({ account: null, refreshToken: null });
    setState({ status: "out" });
  }

  return (
    <div className="space-y-8">
      {state.status === "checking" && <p className="text-muted-foreground">Checking your sign-in…</p>}
      {state.status === "in" && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            {state.signed.account.avatarUrl && <img src={state.signed.account.avatarUrl} alt="" className="size-12 rounded-full" />}
            <p>
              Signed in as <b>{state.signed.account.displayName}</b>
            </p>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
          <Hubs accessToken={state.accessToken} />
        </>
      )}
      {state.status === "out" && (
        <Button className="bg-[#5865F2] text-white hover:bg-[#4752c4]" onClick={() => void signIn()}>
          Sign in with Discord
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
