import type { Embed } from "@app/protocol";

import { useMediaUrl } from "@/lib/media";

/** Link previews under a message. Pictures are this server's copies, never the linked site's. */
export function Embeds({ items }: { items: Embed[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {items.map((e) => (
        <EmbedCard key={e.url} embed={e} />
      ))}
    </div>
  );
}

function EmbedCard({ embed: e }: { embed: Embed }) {
  const image = useMediaUrl(e.image?.url);
  const fit = e.image && fitWithin(e.image.width, e.image.height, e.large ? 400 : 80, e.large ? 300 : 80);
  // A link straight to a picture: just the picture.
  if (!e.title && !e.description && image && fit) {
    return (
      <a href={e.url} target="_blank" rel="noreferrer noopener" data-testid="embed" className="block w-fit overflow-hidden rounded-lg">
        <img src={image} alt="" width={fit.w} height={fit.h} style={{ width: fit.w, height: fit.h }} className="object-contain" />
      </a>
    );
  }
  return (
    <article
      data-testid="embed"
      className="flex max-w-[432px] gap-3 rounded border-l-4 bg-sidebar p-3 pr-4"
      style={{ borderLeftColor: e.color ?? "var(--border)" }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {e.siteName && <span className="truncate text-xs text-muted-foreground">{e.siteName}</span>}
        {e.title && (
          <a href={e.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-sky-400 hover:underline">
            {e.title}
          </a>
        )}
        {e.description && <p className="line-clamp-4 text-sm whitespace-pre-line text-foreground/80">{e.description}</p>}
        {e.large && image && fit && (
          <img src={image} alt="" width={fit.w} height={fit.h} style={{ width: fit.w, height: fit.h }} className="mt-2 max-w-full rounded object-cover" />
        )}
      </div>
      {!e.large && image && fit && <img src={image} alt="" width={fit.w} height={fit.h} style={{ width: fit.w, height: fit.h }} className="shrink-0 rounded object-cover" />}
    </article>
  );
}

function fitWithin(w: number, h: number, maxW: number, maxH: number) {
  if (!w || !h) return null;
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}
