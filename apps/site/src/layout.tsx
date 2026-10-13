import { Link, Outlet } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export const REPO = "https://github.com/pertinate/branchr";
export const RELEASES = `${REPO}/releases/latest`;

/** GitHub's mark (lucide no longer ships brand icons). */
export function GithubMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

const NAV = [
  { to: "/features", label: "Features" },
  { to: "/performance", label: "Performance" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/self-host", label: "Self-host" },
] as const;

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <img src="/icon.svg" alt="" className="size-7" />
      branchr
    </Link>
  );
}

export function Layout() {
  return (
    <div className="flex min-h-svh flex-col bg-[oklch(0.2_0.008_264)] text-foreground">
      <header className="sticky top-0 z-20 border-b border-white/5 bg-[oklch(0.2_0.008_264)]/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav className="hidden gap-5 text-sm text-muted-foreground md:flex">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} className="hover:text-foreground" activeProps={{ className: "text-foreground" }}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex-1" />
          <a href={REPO} className="hidden text-muted-foreground hover:text-foreground sm:block" aria-label="Source on GitHub">
            <GithubMark className="size-5" />
          </a>
          <Button asChild>
            <a href="/app/">Open branchr</a>
          </Button>
        </div>
        {/* The same links on small screens, scrolling sideways if they must. */}
        <nav className="flex gap-4 overflow-x-auto px-4 pb-2 text-sm text-muted-foreground md:hidden">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="shrink-0 hover:text-foreground" activeProps={{ className: "text-foreground" }}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-4 px-4 py-10 text-sm text-muted-foreground sm:px-6">
        <Logo />
        <span>Open source.</span>
        <div className="flex-1" />
        <a href="/app/" className="hover:text-foreground">Open the app</a>
        <Link to="/self-host" className="hover:text-foreground">Run a hub</Link>
        <a href={RELEASES} className="hover:text-foreground">Downloads</a>
        <a href={REPO} className="hover:text-foreground">GitHub</a>
      </footer>
    </div>
  );
}

/** A page's title block. */
export function PageHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden border-b border-white/5">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,oklch(0.585_0.2_277/0.25),transparent)]" />
      <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-10 sm:px-6">
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">{title}</h1>
        {children && <div className="mt-4 max-w-2xl text-lg text-pretty text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}
