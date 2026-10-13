import { Link, useParams } from "@tanstack/react-router";
import { ExternalLink, Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { GuildBadge } from "@/components/guild/guild-badge";
import { emotePage, emoteSource, emoteSrcSet, emoteUrl, providerNames } from "@/lib/emotes";
import { useApp } from "@/stores/app";
import { useEmoteCard } from "@/stores/emotes";

const WIDTH = 256;
const MARGIN = 8;

/** Info card for a clicked emote: what it is and which server it's from. Mounted once. */
export function EmoteCard() {
  const card = useEmoteCard((s) => s.card);
  const close = useEmoteCard((s) => s.close);
  const guild = useApp((s) => (card ? s.guilds[card.emote.guildId] : undefined));
  const current = (useParams({ strict: false }) as { guildId?: string }).guildId;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Above the emote, or below it when there's no room; clamped to the viewport.
  useLayoutEffect(() => {
    if (!card || !ref.current) return setPos(null);
    const h = ref.current.offsetHeight;
    const left = Math.min(Math.max(card.x - WIDTH / 2, MARGIN), window.innerWidth - WIDTH - MARGIN);
    const top = card.y - h - MARGIN >= MARGIN ? card.y - h - MARGIN : card.y + 40;
    setPos({ left, top });
  }, [card]);

  useEffect(() => {
    if (!card) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-emote-id]")) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onScroll = (e: Event) => !ref.current?.contains(e.target as Node) && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [card, close]);

  if (!card) return null;
  const { emote } = card;
  const src = emoteSource(emote);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Emote ${emote.name}`}
      className="fixed z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
      style={{ width: WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <div className="flex items-center gap-3">
        <img src={emoteUrl(src, 2)} srcSet={emoteSrcSet(src)} alt={emote.name} className="h-14 max-w-24 object-contain" draggable={false} />
        <div className="min-w-0">
          <div className="truncate font-semibold">:{emote.name}:</div>
          <a
            href={emotePage(emote)}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {providerNames[emote.provider]} {emote.animated ? "animated emote" : "emote"} <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
      <div className="mt-3 border-t border-border pt-2">
        <div className="mb-1 text-[11px] font-semibold text-muted-foreground uppercase">From</div>
        {guild ? (
          <Link
            to="/$guildId"
            params={{ guildId: guild.id }}
            onClick={close}
            className="-mx-1 flex items-center gap-2 rounded px-1 py-1 hover:bg-accent"
            data-testid="emote-card-guild"
          >
            <GuildBadge guild={guild} className="size-8 text-xs" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{guild.name}</div>
              <div className="text-xs text-muted-foreground">{guild.id === current ? "This community" : "You're a member"}</div>
            </div>
          </Link>
        ) : (
          <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground" data-testid="emote-card-guild">
            <span className="grid size-8 place-items-center rounded bg-muted">
              <Lock className="size-4" />
            </span>
            A community you're not in
          </div>
        )}
      </div>
    </div>
  );
}
