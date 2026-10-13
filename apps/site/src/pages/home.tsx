import { Link } from "@tanstack/react-router";
import { ArrowRight, Download, Gauge, GitBranch, Hash, KeyRound, MessagesSquare, MonitorPlay, Volume2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RELEASES } from "@/layout";

export function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,oklch(0.585_0.2_277/0.35),transparent)]" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 pt-20 pb-16 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:items-center lg:pt-28">
          <div>
            <Badge variant="secondary" className="mb-5">Open source · self-hostable</Badge>
            <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-6xl">
              Chat, voice and streaming <span className="text-primary">you run yourself</span>.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-pretty text-muted-foreground">
              branchr is the chat app you know, with uncapped, low-latency screen and game streaming. Run your own <b className="text-foreground">Hub</b> at home or on a
              server, host <b className="text-foreground">Communities</b> on it, and sign in everywhere with Discord.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <a href="/app/">
                  Open branchr <ArrowRight />
                </a>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link to="/self-host">Run your own Hub</Link>
              </Button>
              <Button size="lg" variant="ghost" asChild>
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
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { to: "/features", icon: MonitorPlay, title: "Everything you'd expect", body: "Communities, roles, threads, voice and uncapped streams, emotes from 7TV and friends." },
            { to: "/performance", icon: Gauge, title: "Measured, not promised", body: "300 viewers of a 60 fps stream, 5,000 sessions on a small VPS: the numbers and how they were taken." },
            { to: "/how-it-works", icon: GitBranch, title: "Yours, wherever it runs", body: "Hubs, one branchr account (sign in with Discord), and reaching a Hub at home." },
          ].map((c) => (
            <Link key={c.to} to={c.to} className="group rounded-xl border border-white/5 bg-card p-5 transition-colors hover:border-primary/40">
              <c.icon className="size-6 text-primary" />
              <h2 className="mt-3 font-semibold">{c.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{c.body}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-sm text-primary">
                More <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
        <div className="mt-6 flex items-center gap-3 rounded-xl border border-white/5 bg-card p-5">
          <KeyRound className="size-6 shrink-0 text-primary" />
          <p className="flex-1 text-sm text-muted-foreground">One account everywhere: sign in with Discord once, and every Hub knows you. Friends, DMs and calls follow you between them.</p>
          <Button variant="secondary" asChild>
            <a href="/app/">Sign in</a>
          </Button>
        </div>
      </section>
    </>
  );
}

/** A picture of the app, drawn rather than screenshotted so it stays crisp and current. */
export function AppMock() {
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

