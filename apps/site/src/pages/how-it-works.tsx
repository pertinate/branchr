import { Eye, GitBranch, Network, Server, Shield } from "lucide-react";

import { PageHead } from "@/layout";

const PARTS = [
  {
    icon: Server,
    title: "A Hub",
    body: "A branchr server: chat, voice and streams for the Communities on it. You run it, on a home server or a VPS, with its data on your disk.",
  },
  {
    icon: Shield,
    title: "branchr ID",
    body: "One account for every Hub, signed in with Discord. Friends, DMs and calls live here, and so does Explore, the directory of Communities that chose to be listed.",
  },
  {
    icon: GitBranch,
    title: "branchr.us, the front door",
    body: "A Hub at home doesn't need a domain or open web ports: it connects out to branchr.us, and people reach it at branchr.us/h/<its key>, like a Plex server through plex.tv.",
  },
  {
    icon: Network,
    title: "Voice and video go direct",
    body: "Calls and streams flow straight between people and the Hub (the router forwards its voice ports, automatically where it supports UPnP), so streams are as fast as the Hub's connection and never queue behind a relay.",
  },
];

export function HowItWorksPage() {
  return (
    <>
      <PageHead title="How it works">Three pieces: Hubs you run, one account for all of them, and a front door so a Hub at home is easy to reach.</PageHead>
      <section className="mx-auto max-w-6xl space-y-10 px-4 py-12 sm:px-6">
        <div className="grid gap-4 md:grid-cols-2">
          {PARTS.map((p, i) => (
            <article key={p.title} className="rounded-xl border border-white/5 bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
                  <p.icon className="size-5" />
                </span>
                <span className="text-xs font-semibold text-muted-foreground">0{i + 1}</span>
              </div>
              <h2 className="mt-3 font-semibold">{p.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{p.body}</p>
            </article>
          ))}
        </div>
        <div className="rounded-xl border border-white/5 bg-card p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Eye className="size-5 text-primary" /> Who sees what
          </h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>People never see each other's addresses: everyone connects to the Hub, not to each other.</li>
            <li>Through branchr.us, a Hub never sees visitors' real addresses, only a stand-in per visitor.</li>
            <li>People in a call on a Hub can see that Hub's address, since media goes to it directly. A Hub owner who'd rather hide it can run a relay of their own.</li>
            <li>Each Hub keeps its own messages and files; branchr ID holds accounts, friends and DMs.</li>
          </ul>
        </div>
      </section>
    </>
  );
}
