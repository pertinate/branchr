import type { AuthResponse, InstanceInfo } from "@app/protocol";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSessions } from "@/lib/instances";
import { type Landing, instanceInfo, landAfterLogin, loginWithBranchr } from "@/lib/server-login";
import { useAuth } from "@/stores/auth";

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string; server?: string; invite?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    /** A host to log in to (adding it alongside the ones you're on). */
    server: typeof s.server === "string" ? s.server : undefined,
    /** An invite to join there once logged in. */
    invite: typeof s.invite === "string" ? s.invite : undefined,
  }),
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const { redirect, server: wanted, invite } = Route.useSearch();
  const [mode, setMode] = useState<"login" | "register">("login");
  // Already logged in somewhere: this adds another host.
  const adding = useSessions((s) => s.sessions.length > 0);
  const [server, setServer] = useState(wanted ?? (adding ? "" : useAuth.getState().serverUrl));
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<InstanceInfo | null>(null);

  const land = (to: Landing) => {
    if (to.guildId) void navigate({ to: "/$instance/$guildId", params: { instance: to.instance, guildId: to.guildId } });
    else if (redirect && !adding) void navigate({ to: redirect });
    else void navigate({ to: "/$instance", params: { instance: to.instance } });
  };

  // Which logins does this server offer?
  useEffect(() => {
    const base = server.trim().replace(/\/+$/, "");
    setInfo(null);
    if (!/^https?:\/\/.+/.test(base)) return;
    let live = true;
    const t = setTimeout(() => {
      instanceInfo(base).then(
        (i) => live && setInfo(i),
        () => {},
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [server]);
  const branchr = !!info && info.authMode !== "local";
  const passwords = !info || info.authMode !== "federated";

  const withBranchr = async () => {
    setBusy(true);
    setError(null);
    try {
      const to = await loginWithBranchr(server.trim().replace(/\/+$/, ""), invite);
      if (to) land(to);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const base = server.trim().replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "login" ? { username, password } : { username, password, displayName: displayName || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? "Invalid username or password" : (body.error ?? res.statusText));
      }
      const auth = (await res.json()) as AuthResponse;
      useAuth.getState().setSession(base, auth.token, auth.user);
      land(await landAfterLogin(base, invite));
    } catch (err) {
      setError(err instanceof TypeError ? `Can't reach ${base}` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-[radial-gradient(ellipse_at_top,_var(--primary)_0%,_transparent_60%)]">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-lg bg-background p-8 shadow-2xl">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">{adding ? "Connect another host" : mode === "login" ? "Welcome back!" : "Create an account"}</h1>
          <p className="text-sm text-muted-foreground">
            {adding
              ? "Log in to another self-hosted branchr. You stay connected to the others."
              : mode === "login"
                ? "We're so excited to see you again!"
                : "Join your self-hosted community."}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="server" className="text-xs font-bold uppercase text-muted-foreground">Server</Label>
          <Input id="server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://chat.example.com" />
        </div>
        {branchr && (
          <>
            <Button type="button" className="w-full bg-[#5865F2] text-white hover:bg-[#4752c4]" disabled={busy} onClick={() => void withBranchr()}>
              Sign in with Discord
            </Button>
            {passwords && <div className="text-center text-xs text-muted-foreground uppercase">or use a server account</div>}
          </>
        )}
        {passwords && (
        <>
        <div className="space-y-2">
          <Label htmlFor="username" className="text-xs font-bold uppercase text-muted-foreground">Username</Label>
          <Input id="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </div>
        {mode === "register" && (
          <div className="space-y-2">
            <Label htmlFor="display" className="text-xs font-bold uppercase text-muted-foreground">Display name</Label>
            <Input id="display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="password" className="text-xs font-bold uppercase text-muted-foreground">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {mode === "login" ? "Log In" : "Continue"}
        </Button>
        <p className="text-sm text-muted-foreground">
          {mode === "login" ? "Need an account? " : "Already have an account? "}
          <button type="button" className="text-primary hover:underline" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "Register" : "Log In"}
          </button>
        </p>
        </>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {adding && (
          <p className="text-center text-sm">
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => void navigate({ to: "/" })}>
              Cancel
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
