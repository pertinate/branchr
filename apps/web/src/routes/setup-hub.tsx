import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, CheckCircle2, Copy, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ID_URL, branchrApi, setAfterSignIn, startSignIn, useBranchrId } from "@/lib/branchr-id";
import { loginWithBranchr } from "@/lib/server-login";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/setup-hub")({
  validateSearch: (s: Record<string, unknown>): { code?: string; name?: string } => ({
    code: typeof s.code === "string" ? s.code : undefined,
    name: typeof s.name === "string" ? s.name : undefined,
  }),
  component: SetupHub,
});

const IMAGE = "ghcr.io/pertinate/branchr:latest";

/** A voice secret for this hub, made here and kept for this code (so a reload shows the same). */
function useVoiceSecret(code: string | undefined) {
  return useMemo(() => {
    if (!code) return "";
    const key = `setup-secret-${code}`;
    try {
      const kept = sessionStorage.getItem(key);
      if (kept) return kept;
    } catch {
      /* private mode */
    }
    const s = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try {
      sessionStorage.setItem(key, s);
    } catch {
      /* fine */
    }
    return s;
  }, [code]);
}

/** Setting up a Hub at home: a code from branchr, one paste on the server, and it's yours. */
function SetupHub() {
  const { code, name } = Route.useSearch();
  const account = useBranchrId((s) => s.account);
  const navigate = useNavigate();
  const [draft, setDraft] = useState(name ?? "");
  const [busy, setBusy] = useState(false);

  const getCode = async () => {
    setBusy(true);
    try {
      const r = await branchrApi<{ code: string }>("POST", "/setup-codes", { name: draft.trim() });
      void navigate({ to: "/setup-hub", search: { code: r.code, name: draft.trim() }, replace: true });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Set up a Hub</h1>
          <p className="mt-2 text-muted-foreground">
            Run branchr on your own machine (a home server, an Unraid box, a VPS). People reach it through branchr.us, so you don't need a domain or to open web ports.
          </p>
        </div>

        <Section n={1} title="Sign in" done={!!account}>
          {account ? (
            <p>
              Signed in as <b className="text-foreground">{account.displayName}</b>. The Hub will be yours.
            </p>
          ) : (
            <Button
              className="bg-[#5865F2] text-white hover:bg-[#4752c4]"
              onClick={() => {
                setAfterSignIn("/setup-hub");
                void startSignIn();
              }}
            >
              Sign in with Discord
            </Button>
          )}
        </Section>

        <Section n={2} title="Name it" done={!!code} disabled={!account}>
          {code ? (
            <p>
              <b className="text-foreground">{name}</b> · setup code <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">{code}</code> (works once, for 24 hours)
            </p>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) void getCode();
              }}
            >
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Game Night" maxLength={100} aria-label="Hub name" disabled={!account} />
              <Button type="submit" disabled={!account || !draft.trim() || busy}>
                Get a setup code
              </Button>
            </form>
          )}
        </Section>

        <Section n={3} title="Run it on your machine" disabled={!code}>
          {code && name && <RunIt code={code} name={name} />}
        </Section>

        <Section n={4} title="Wait for it to check in" disabled={!code}>
          {code && <CheckIn code={code} />}
        </Section>
      </div>
    </div>
  );
}

function Section({ n, title, done, disabled, children }: { n: number; title: string; done?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <section className={cn("grid grid-cols-[2rem_1fr] gap-4", disabled && "opacity-50")}>
      <span className={cn("grid size-8 place-items-center rounded-full text-sm font-semibold", done ? "bg-online text-white" : "bg-primary/15 text-primary")}>
        {done ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 space-y-3 pt-1 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {children}
      </div>
    </section>
  );
}

function Code({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-[oklch(0.2_0.006_264)] p-3 pr-12 text-xs leading-relaxed text-foreground">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        className="absolute top-2 right-2 rounded p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

function RunIt({ code, name }: { code: string; name: string }) {
  const secret = useVoiceSecret(code);
  // Host networking: the voice server can then ask the router to open its ports (UPnP), and
  // the api reaches it on localhost.
  const env = {
    api: [
      ["API_BIND", "0.0.0.0:8740"],
      ["VOICE_SECRET", secret],
      ["BRANCHR_SETUP", code],
      ["BRANCHR_ID_URL", ID_URL],
      ["AUTH_MODE", "both"],
      ["RELAY", "1"],
      ["TRUST_PROXY", "1"],
      ["INSTANCE_NAME", name],
      ["SFU_URLS", "ws://127.0.0.1:8741/ws"],
    ],
    sfu: [
      ["SFU_BIND", "0.0.0.0:8741"],
      ["VOICE_SECRET", secret],
      ["SFU_PUBLIC_IP", "auto"],
      ["SFU_UDP_PORT", "51000"],
      ["SFU_WORKERS", "4"],
    ],
  };
  const quote = (v: string) => (/[^A-Za-z0-9_.:/-]/.test(v) ? JSON.stringify(v) : v);
  const compose = `# branchr hub "${name}"; save as docker-compose.yml, then: docker compose up -d
services:
  api:
    image: ${IMAGE}
    command: ["api"]
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/data
    environment:
${env.api.map(([k, v]) => `      ${k}: ${quote(v)}`).join("\n")}
  sfu:
    image: ${IMAGE}
    command: ["sfu"]
    restart: unless-stopped
    network_mode: host
    environment:
${env.sfu.map(([k, v]) => `      ${k}: ${quote(v)}`).join("\n")}
`;
  const run = (svc: "api" | "sfu", extra: string) =>
    `docker run -d --name branchr-${svc} --restart unless-stopped --network host ${extra}\\\n${env[svc].map(([k, v]) => `  -e ${k}=${quote(v)} \\`).join("\n")}\n  ${IMAGE} ${svc}`;
  const docker = `${run("api", "-v /mnt/user/appdata/branchr:/data ")}\n\n${run("sfu", "")}`;
  return (
    <>
      <p>Paste one of these on the machine (it needs Docker). The setup code is in it: keep it to yourself until it's used.</p>
      <Tabs defaultValue="compose">
        <TabsList>
          <TabsTrigger value="compose">Docker Compose</TabsTrigger>
          <TabsTrigger value="docker">docker run (Unraid, any Docker)</TabsTrigger>
        </TabsList>
        <TabsContent value="compose">
          <Code text={compose} label="compose file" />
        </TabsContent>
        <TabsContent value="docker">
          <Code text={docker} label="docker commands" />
          <p className="mt-2 text-xs">On something other than Unraid, change /mnt/user/appdata/branchr to wherever its data should live.</p>
        </TabsContent>
      </Tabs>
      <p className="text-xs">
        Voice and video go to the Hub directly, on UDP 51000–51003. If your router supports UPnP the Hub opens them itself; if not, forward them to this machine. Manage Hub
        shows whether they're reachable.
      </p>
    </>
  );
}

function CheckIn({ code }: { code: string }) {
  const navigate = useNavigate();
  const [key, setKey] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [expired, setExpired] = useState(false);
  const [opening, setOpening] = useState(false);
  // Where relayed Hubs are reached (branchr.us itself, normally).
  const [web, setWeb] = useState(ID_URL);
  useEffect(() => {
    fetch(`${ID_URL}/relay`)
      .then((r) => (r.ok ? r.json() : null))
      .then((i: { web?: string } | null) => i?.web && setWeb(i.web.replace(/\/+$/, "")))
      .catch(() => {});
  }, []);
  const hub = key ? `${web}/h/${key}` : null;

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        if (!key) {
          const st = await branchrApi<{ instanceId: string | null; expired: boolean }>("GET", `/setup-codes/${encodeURIComponent(code)}`);
          if (!live) return;
          setExpired(st.expired && !st.instanceId);
          if (st.instanceId) setKey(st.instanceId);
        } else if (!online) {
          const r = await fetch(`${web}/h/${key}/api/health`);
          if (live && r.ok) setOnline(true);
        }
      } catch {
        /* keep waiting */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [code, key, online, web]);

  const open = async () => {
    if (!hub) return;
    setOpening(true);
    try {
      const to = await loginWithBranchr(hub);
      if (to?.guildId) void navigate({ to: "/$guildId", params: { guildId: to.guildId } });
      else if (to) void navigate({ to: "/hub/$instance", params: { instance: to.instance } });
    } catch (e) {
      toast.error((e as Error).message);
      setOpening(false);
    }
  };

  if (expired) return <p className="text-dnd">This setup code expired before a Hub used it. Get a new one above.</p>;
  return (
    <div className="space-y-2" data-testid="setup-status">
      <Line done={!!key} text={key ? "Your Hub checked in with branchr: it's yours." : "Waiting for your Hub to start…"} />
      {key && <Line done={online} text={online ? `Reachable through branchr.us (key ${key.slice(0, 8)}).` : "Connecting it through branchr.us…"} />}
      {online && (
        <Button className="mt-2" onClick={() => void open()} disabled={opening}>
          Open your Hub
        </Button>
      )}
    </div>
  );
}

function Line({ done, text }: { done: boolean; text: string }) {
  return (
    <div className={cn("flex items-center gap-2", done && "text-foreground")}>
      {done ? <CheckCircle2 className="size-4 text-online" /> : <Loader2 className="size-4 animate-spin" />}
      {text}
    </div>
  );
}
