import {
  ArrowRight,
  AudioLines,
  Download,
  Gauge,
  GitBranch,
  Github,
  Hash,
  KeyRound,
  Leaf,
  MessagesSquare,
  MonitorPlay,
  Server,
  Shield,
  Smile,
  Volume2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const REPO = "https://github.com/pertinate/branchr";
const RELEASES = `${REPO}/releases/latest`;

export function App() {
  return (
    <div className="min-h-svh bg-[oklch(0.2_0.008_264)] text-foreground">
      <Nav />
      <Hero />
      <Features />
      <Numbers />
      <HowItWorks />
      <SelfHost />
      <Footer />
    </div>
  );
}

function Logo() {
  return (
    <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="/icon.svg" alt="" className="size-7" />
      branchr
    </a>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-[oklch(0.2_0.008_264)]/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        <nav className="hidden gap-5 text-sm text-muted-foreground md:flex">
          <a href="#features" className="hover:text-foreground">Features</a>
          <a href="#numbers" className="hover:text-foreground">Performance</a>
          <a href="#how" className="hover:text-foreground">How it works</a>
          <a href="#self-host" className="hover:text-foreground">Self-host</a>
        </nav>
        <div className="flex-1" />
        <a href={REPO} className="hidden text-muted-foreground hover:text-foreground sm:block" aria-label="Source on GitHub">
          <Github className="size-5" />
        </a>
        <Button asChild>
          <a href="/app/">Open branchr</a>
        </Button>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.585_0.2_277/0.35),transparent)]" />
      <div className="relative mx-auto grid max-w-6xl gap-12 px-4 pt-20 pb-16 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:items-center lg:pt-28">
        <div>
          <Badge variant="secondary" className="mb-5">Open source · self-hostable</Badge>
          <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-6xl">
            Chat, voice and streaming <span className="text-primary">you run yourself</span>.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-pretty text-muted-foreground">
            branchr is the chat app you know, with uncapped, low-latency screen and game streaming. Run your own <b className="text-foreground">hub</b> at home or on a
            server, grow <b className="text-foreground">communities</b> on it, and sign in everywhere with Discord.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <a href="/app/">
                Open branchr <ArrowRight />
              </a>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <a href={RELEASES}>
                <Download /> Desktop app
              </a>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">Linux (AppImage) and Windows. Or straight from the browser.</p>
        </div>
        <AppMock />
      </div>
    </section>
  );
}

/** A picture of the app, drawn rather than screenshotted so it stays crisp and current. */
function AppMock() {
  const communities = ["GM", "LP", "◆", "RT"];
  return (
    <div className="relative rounded-2xl border border-white/10 bg-rail p-2 shadow-2xl shadow-primary/20" aria-hidden>
      <div className="flex h-[380px] overflow-hidden rounded-xl sm:h-[420px]">
        <div className="flex w-14 shrink-0 flex-col items-center gap-2 bg-rail py-3">
          <div className="grid size-10 place-items-center rounded-2xl bg-primary text-white">
            <MessagesSquare className="size-5" />
          </div>
          <div className="h-0.5 w-6 rounded bg-accent" />
          {communities.map((l, i) => (
            <div key={l} className={`grid size-10 place-items-center rounded-3xl text-xs font-semibold ${i === 0 ? "rounded-2xl bg-primary text-white" : "bg-background"}`}>
              {l}
            </div>
          ))}
        </div>
        <div className="hidden w-44 shrink-0 flex-col gap-1 bg-sidebar p-2 text-sm text-sidebar-foreground sm:flex">
          <div className="mb-2 px-2 py-1 font-semibold text-foreground">Game Night</div>
          {["general", "clips", "lfg"].map((c, i) => (
            <div key={c} className={`flex items-center gap-1.5 rounded px-2 py-1 ${i === 0 ? "bg-sidebar-accent text-foreground" : ""}`}>
              <Hash className="size-4 opacity-70" /> {c}
            </div>
          ))}
          <div className="mt-3 px-2 text-[10px] font-semibold tracking-wide uppercase">Voice</div>
          <div className="flex items-center gap-1.5 px-2 py-1">
            <Volume2 className="size-4 opacity-70" /> Lounge
          </div>
          {["Nelly", "Rowan"].map((n) => (
            <div key={n} className="flex items-center gap-2 pl-7 text-xs">
              <span className="size-4 rounded-full bg-primary/70" /> {n}
              {n === "Nelly" && <span className="rounded bg-live px-1 text-[9px] font-bold text-white">LIVE</span>}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <div className="flex h-10 items-center gap-1.5 border-b border-black/20 px-3 text-sm font-semibold">
            <Hash className="size-4 text-muted-foreground" /> general
          </div>
          <div className="m-3 grid aspect-video place-items-center overflow-hidden rounded-lg bg-[linear-gradient(135deg,oklch(0.35_0.12_277),oklch(0.3_0.1_200))]">
            <div className="text-center text-white/90">
              <MonitorPlay className="mx-auto size-8" />
              <div className="mt-1 text-xs font-semibold">Nelly's stream · 1440p60</div>
            </div>
          </div>
          <div className="space-y-3 px-3 text-sm">
            {[
              ["Rowan", "that clutch 👀"],
              ["Nelly", "streaming at full bitrate, no cap 🎮"],
            ].map(([who, text]) => (
              <div key={text} className="flex gap-2">
                <span className="size-7 shrink-0 rounded-full bg-primary/60" />
                <div>
                  <div className="text-xs font-semibold">{who}</div>
                  <div className="text-foreground/90">{text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: MonitorPlay,
    title: "Uncapped streaming",
    body: "Screen and game streams go through a Rust SFU with no bitrate cap: 60 fps to every viewer, single-digit-millisecond relay latency on a LAN.",
  },
  {
    icon: GitBranch,
    title: "Your own hub",
    body: "A hub is a branchr server you run: Docker on a home server or a VPS, SQLite or Postgres, files on disk or in an S3 bucket.",
  },
  {
    icon: KeyRound,
    title: "One sign-in everywhere",
    body: "Sign in with Discord once and use every hub. Friends, DMs and calls follow your branchr account across all of them.",
  },
  {
    icon: Leaf,
    title: "Communities with everything",
    body: "Roles and channel permissions, threads, pins, search, slow mode, webhooks, link previews, moderation and an audit log.",
  },
  {
    icon: Smile,
    title: "Your emotes",
    body: "Bring emotes from 7TV, BetterTTV and FrankerFaceZ, or import a whole Twitch channel's set, and use them across communities.",
  },
  {
    icon: AudioLines,
    title: "Desktop apps",
    body: "Linux AppImage with hardware video encoding and per-app PipeWire audio for streams, AI noise suppression for your mic, and Windows.",
  },
];

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-20 sm:px-6">
      <h2 className="text-3xl font-bold tracking-tight">Everything you'd expect, and the parts you'd own</h2>
      <p className="mt-3 max-w-2xl text-muted-foreground">Familiar from day one. The difference is where it runs and how hard it can stream.</p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article key={f.title} className="rounded-xl border border-white/5 bg-card p-5">
            <f.icon className="size-6 text-primary" />
            <h3 className="mt-3 font-semibold">{f.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

const NUMBERS = [
  { value: "300 × 60 fps", label: "viewers of one 4 Mbps stream, p99 7.3 ms through the SFU" },
  { value: "5,000", label: "connected sessions on a 2 vCPU VPS, every message to all of them" },
  { value: "~1,100 / s", label: "chat messages on a home server, 100,000 deliveries" },
  { value: "100 people", label: "in one voice call, all speech delivered, p99 9 ms" },
];

function Numbers() {
  return (
    <section id="numbers" className="scroll-mt-16 border-y border-white/5 bg-rail/60">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Gauge className="size-4" /> Measured, not promised
        </div>
        <div className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {NUMBERS.map((n) => (
            <div key={n.value}>
              <div className="text-3xl font-bold tracking-tight">{n.value}</div>
              <p className="mt-1 text-sm text-muted-foreground">{n.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 text-xs text-muted-foreground">
          From the load tests in the repository (<a className="underline hover:text-foreground" href={`${REPO}#performance`}>methods and full tables</a>): a Ryzen desktop, a DigitalOcean VPS, and a real Unraid deployment.
        </p>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { icon: Server, title: "A hub", body: "Your branchr server: chat, voice and streams for the communities on it. Yours, wherever it runs." },
    { icon: Shield, title: "branchr ID", body: "One account (sign in with Discord) for every hub, plus friends, DMs and the Explore directory." },
    { icon: GitBranch, title: "The relay", body: "No public IP at home? The hub dials out to the gateway, Plex-style, and people reach it at its own address." },
  ];
  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-16 px-4 py-20 sm:px-6">
      <h2 className="text-3xl font-bold tracking-tight">How it fits together</h2>
      <div className="mt-10 grid gap-4 lg:grid-cols-3">
        {steps.map((s, i) => (
          <div key={s.title} className="relative rounded-xl border border-white/5 bg-card p-5">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
                <s.icon className="size-5" />
              </span>
              <span className="text-xs font-semibold text-muted-foreground">0{i + 1}</span>
            </div>
            <h3 className="mt-3 font-semibold">{s.title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SelfHost() {
  return (
    <section id="self-host" className="scroll-mt-16 border-t border-white/5 bg-rail/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:items-center">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Run a hub in minutes</h2>
          <p className="mt-3 text-muted-foreground">
            One Docker image with the api, the SFU and the web app. Start it on a home server or a VPS, sign in with Discord, and claim it with the code it prints.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href={`${REPO}#self-hosting`}>Self-hosting guide</a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={REPO}>
                <Github /> Source
              </a>
            </Button>
          </div>
        </div>
        <pre className="overflow-x-auto rounded-xl border border-white/10 bg-[oklch(0.17_0.006_264)] p-5 text-sm leading-relaxed">
          <code>
            <span className="text-muted-foreground"># on your server</span>
            {"\n"}git clone {REPO}.git && cd branchr
            {"\n"}docker compose up -d
            {"\n\n"}
            <span className="text-muted-foreground"># then open it and sign in</span>
            {"\n"}open http://your-server:8080/app/
          </code>
        </pre>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-10 text-sm text-muted-foreground sm:px-6">
      <Logo />
      <span>Open source, MIT licensed.</span>
      <div className="flex-1" />
      <a href="/app/" className="hover:text-foreground">Open the app</a>
      <a href={RELEASES} className="hover:text-foreground">Downloads</a>
      <a href={REPO} className="hover:text-foreground">GitHub</a>
    </footer>
  );
}
