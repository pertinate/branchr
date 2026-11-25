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
