import type { Emote } from "@app/protocol";

export function emoteUrl(providerId: string, size: 1 | 2 | 3 | 4 = 2) {
  return `https://cdn.7tv.app/emote/${providerId}/${size}x.webp`;
}

export function emoteSrcSet(providerId: string) {
  return `${emoteUrl(providerId, 1)} 1x, ${emoteUrl(providerId, 2)} 2x, ${emoteUrl(providerId, 4)} 4x`;
}

/** name -> emote, case sensitive like 7TV. */
export function emoteMap(emotes: Emote[] | undefined): Map<string, Emote> {
  const m = new Map<string, Emote>();
  for (const e of emotes ?? []) m.set(e.name, e);
  return m;
}
