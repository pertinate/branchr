"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { GithubMark, RELEASES, REPO } from "@/components/site";
import { Button } from "@/components/ui/button";

const NAV = [
  { to: "/features", label: "Features" },
  { to: "/performance", label: "Performance" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/self-host", label: "Self-host" },
] as const;

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="/icon.svg" alt="" className="size-7" />
      branchr
    </Link>
  );
}

function Nav({ className, itemClass }: { className: string; itemClass: string }) {
  const path = usePathname();
  return (
    <nav className={className}>
      {NAV.map((n) => (
        <Link key={n.to} href={n.to} className={`${itemClass} ${path === n.to ? "text-foreground" : "hover:text-foreground"}`}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-[oklch(0.2_0.008_264)]/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        <Nav className="hidden gap-5 text-sm text-muted-foreground md:flex" itemClass="" />
        <div className="flex-1" />
        <a href={REPO} className="hidden text-muted-foreground hover:text-foreground sm:block" aria-label="Source on GitHub">
          <GithubMark className="size-5" />
        </a>
        <Link href="/account" className="text-sm text-muted-foreground hover:text-foreground">Account</Link>
        <Button asChild>
          <a href="/app/">Open branchr</a>
        </Button>
      </div>
      {/* The same links on small screens, scrolling sideways if they must. */}
      <Nav className="flex gap-4 overflow-x-auto px-4 pb-2 text-sm text-muted-foreground md:hidden" itemClass="shrink-0" />
    </header>
  );
}

export function Footer() {
  return (
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-4 px-4 py-10 text-sm text-muted-foreground sm:px-6">
        <Logo />
        <span>Open source.</span>
        <div className="flex-1" />
        <a href="/app/" className="hover:text-foreground">Open the app</a>
        <Link href="/self-host" className="hover:text-foreground">Run a hub</Link>
        <a href={RELEASES} className="hover:text-foreground">Downloads</a>
        <a href={REPO} className="hover:text-foreground">GitHub</a>
      </footer>
  );
}
