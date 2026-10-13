import { AudioLines, GitBranch, KeyRound, Leaf, MonitorPlay, Search, Shield, Smile } from "lucide-react";

import { PageHead } from "@/layout";

const FEATURES = [
  {
    icon: MonitorPlay,
    title: "Uncapped streaming",
    body: "Screen and game streams go through a Rust SFU with no bitrate cap: 60 fps to every viewer, single-digit-millisecond relay latency on a LAN.",
  },
  {
    icon: GitBranch,
    title: "Your own Hub",
    body: "A Hub is a branchr server you run: Docker on a home server or a VPS, SQLite or Postgres, files on disk or in an S3 bucket.",
  },
  {
    icon: KeyRound,
    title: "One sign-in everywhere",
    body: "Sign in with Discord once and use every Hub. Friends, DMs and calls follow your branchr account across all of them.",
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

const MORE = [
  { icon: Search, title: "Search everywhere", body: "Search messages in one community, or across every community on every Hub you're in at once." },
  { icon: Shield, title: "Moderation", body: "Bans, an audit log, slow mode, per-channel permissions, and Hub-wide staff roles for whoever runs the Hub." },
];

export function FeaturesPage() {
  return (
    <>
      <PageHead title="Features">Familiar from day one. The difference is where it runs and how hard it can stream.</PageHead>
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...FEATURES, ...MORE].map((f) => (
            <article key={f.title} className="rounded-xl border border-white/5 bg-card p-5">
              <f.icon className="size-6 text-primary" />
              <h2 className="mt-3 font-semibold">{f.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
