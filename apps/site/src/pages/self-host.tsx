import { Check, Copy, Home, Server } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { PageHead, REPO } from "@/layout";

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-white/10 bg-[oklch(0.17_0.006_264)] p-4 pr-12 text-sm leading-relaxed">
        <code>{children}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy"
        className="absolute top-2 right-2 rounded p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-4">
      <span className="grid size-8 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">{n}</span>
      <div className="min-w-0 space-y-3">
        <h3 className="pt-1 font-semibold">{title}</h3>
        <div className="space-y-3 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

export function SelfHostPage() {
  return (
    <>
      <PageHead title="Run your own Hub">A Hub is one Docker setup. It gets its own branchr key the first time it starts, and you claim it by signing in.</PageHead>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-10">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Server className="size-5 text-primary" /> On a server with its own domain
          </div>
          <ol className="space-y-8">
            <Step n={1} title="Get a server ready">
              <p>Any Linux machine with Docker (a small VPS is plenty to start). Point a domain at it, and allow TCP 80 and 443 and UDP 50000–50003 through its firewall.</p>
            </Step>
            <Step n={2} title="Fetch branchr and say where it lives">
              <Code>{`git clone ${REPO}.git && cd branchr
cp .env.example .env
cat >> .env <<'EOF'
DOMAIN=chat.example.com
PUBLIC_HOST=chat.example.com
PUBLIC_URL=https://chat.example.com
PUBLIC_IP=203.0.113.10
VOICE_SECRET=$(openssl rand -hex 32)
INSTANCE_NAME=My Hub
AUTH_MODE=both
BRANCHR_ID_URL=https://branchr.us
EOF`}</Code>
              <p>Use your domain and the server's public IP. Replace the VOICE_SECRET line with the output of <code className="rounded bg-muted px-1">openssl rand -hex 32</code>.</p>
            </Step>
            <Step n={3} title="Start it">
              <Code>{`docker compose -f docker-compose.yml \\
  -f deploy/docker-compose.public.yml up -d --build`}</Code>
              <p>The first build takes a few minutes. Caddy gets an HTTPS certificate for your domain on its own.</p>
            </Step>
            <Step n={4} title="Claim it with its key">
              <p>On first start the Hub registers with branchr and gets its key. It prints a one-time claim code:</p>
              <Code>{`docker compose logs api | grep "claim this server"`}</Code>
              <p>
                Open <b className="text-foreground">https://your-domain/app/</b>, sign in with Discord, then <b className="text-foreground">User Settings → Claim a hub</b> and enter the code. You now own
                it: Manage Hub has its settings, staff and bans.
              </p>
            </Step>
          </ol>
        </div>
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
            <div className="flex items-center gap-2 font-semibold">
              <Home className="size-5 text-primary" /> At home, no domain
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Coming next: get your Hub's key right here, paste one command on your home server or Unraid box, and it's reachable at branchr.us/h/&lt;its key&gt; with
              no web ports to open. This page will walk you through it and check that voice can reach it.
            </p>
          </div>
          <div className="rounded-xl border border-white/5 bg-card p-5 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">More options</p>
            <p className="mt-2">Postgres instead of SQLite, files in an S3 bucket, the desktop app, and every setting are in the README.</p>
            <Button variant="secondary" size="sm" className="mt-3" asChild>
              <a href={`${REPO}#self-hosting`}>Self-hosting guide</a>
            </Button>
          </div>
        </aside>
      </section>
    </>
  );
}
