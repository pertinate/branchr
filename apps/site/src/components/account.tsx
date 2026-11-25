"use client";

import { useEffect, useState } from "react";

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

export function Account() {
  const [signed, setSigned] = useState<Signed | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    complete()
      .catch((e: Error) => setError(e.message))
      .finally(() => setSigned(stored()));
  }, []);

  async function signOut() {
    const token = stored()?.refreshToken;
    if (token) await fetch("/logout", { method: "POST", body: new URLSearchParams({ refresh_token: token }) }).catch(() => {});
    save({ account: null, refreshToken: null });
    setSigned(null);
  }

  if (signed === undefined) return <p className="text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-4">
      {signed ? (
        <div className="flex items-center gap-4">
          {signed.account.avatarUrl && <img src={signed.account.avatarUrl} alt="" className="size-12 rounded-full" />}
          <p>
            Signed in as <b>{signed.account.displayName}</b>
          </p>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : (
        <Button className="bg-[#5865F2] text-white hover:bg-[#4752c4]" onClick={() => void signIn()}>
          Sign in with Discord
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
