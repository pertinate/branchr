/**
 * Discord-style filters in a search: `from:someone`, `in:channel` and `has:link|file|image`,
 * the rest being words. Names are matched against the community's members and channels.
 */
import type { AppState } from "@/stores/app";

export const HAS = ["link", "file", "image"] as const;
export type Has = (typeof HAS)[number];

export interface ParsedSearch {
  words: string;
  author?: string;
  channel?: string;
  has?: Has;
  /** Why the search can't run (an unknown name, say). */
  error?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/^[@#]/, "");

export function parseSearch(query: string, s: Pick<AppState, "members" | "channels">, guildId: string): ParsedSearch {
  const out: ParsedSearch = { words: "" };
  const words: string[] = [];
  for (const token of query.split(/\s+/).filter(Boolean)) {
    const m = /^(from|in|has):(.+)$/i.exec(token);
    if (!m) {
      words.push(token);
      continue;
    }
    const [, key, raw] = m;
    const value = norm(raw);
    switch (key.toLowerCase()) {
      case "from": {
        const members = Object.values(s.members[guildId] ?? {});
        const hit =
          members.find((x) => x.user.username.toLowerCase() === value) ??
          members.find((x) => (x.nick ?? x.user.displayName).toLowerCase() === value) ??
          members.find((x) => x.user.username.toLowerCase().startsWith(value) || (x.nick ?? x.user.displayName).toLowerCase().startsWith(value));
        if (!hit) return { ...out, error: `No one here called ${raw}.` };
        out.author = hit.user.id;
        break;
      }
      case "in": {
        const hit = Object.values(s.channels).find((c) => c.guildId === guildId && (c.kind === "text" || c.kind === "thread") && c.name.toLowerCase() === value);
        if (!hit) return { ...out, error: `No channel called #${value}.` };
        out.channel = hit.id;
        break;
      }
      case "has":
        if (!(HAS as readonly string[]).includes(value)) return { ...out, error: `has: takes ${HAS.join(", ")}.` };
        out.has = value as Has;
        break;
    }
  }
  out.words = words.join(" ");
  return out;
}

/** The query string for the search endpoint. */
export function searchParams(p: ParsedSearch, offset: number): string {
  const q = new URLSearchParams({ q: p.words, offset: String(offset) });
  if (p.author) q.set("author", p.author);
  if (p.channel) q.set("channel", p.channel);
  if (p.has) q.set("has", p.has);
  return q.toString();
}
