import type { Emote, EmoteProvider } from "@app/protocol";

/** Enough to locate an emote image on its provider's CDN. */
export interface EmoteSource {
  provider: EmoteProvider;
  id: string;
  animated: boolean;
}

export const providerNames: Record<EmoteProvider, string> = { "7tv": "7TV", bttv: "BetterTTV", ffz: "FrankerFaceZ" };

export function emoteSource(e: Emote): EmoteSource {
  return { provider: e.provider, id: e.providerId, animated: e.animated };
}

/** Image url at a pixel density (1x is ~28-32px tall). */
export function emoteUrl(s: EmoteSource, density: 1 | 2 | 4 = 2) {
  switch (s.provider) {
    case "bttv":
      return `https://cdn.betterttv.net/emote/${s.id}/${density === 4 ? 3 : density}x.webp`;
    case "ffz":
      return `https://cdn.frankerfacez.com/emote/${s.id}/${s.animated ? "animated/" : ""}${density}`;
    default:
      return `https://cdn.7tv.app/emote/${s.id}/${density}x.webp`;
  }
}

export function emoteSrcSet(s: EmoteSource) {
  const top = s.provider === "bttv" ? "3x" : "4x";
  return `${emoteUrl(s, 1)} 1x, ${emoteUrl(s, 2)} 2x, ${emoteUrl(s, 4)} ${top}`;
}

/** name -> emote, case sensitive like 7TV. */
export function emoteMap(emotes: Emote[] | undefined): Map<string, Emote> {
  const m = new Map<string, Emote>();
  for (const e of emotes ?? []) m.set(e.name, e);
  return m;
}
