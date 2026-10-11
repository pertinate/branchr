import type { Emote } from "@app/protocol";
import { Fragment, type ReactNode, memo } from "react";

import { emoteSource, emoteSrcSet, emoteUrl } from "@/lib/emotes";

/**
 * Discord-flavoured markdown subset: ```code blocks```, `inline code`, **bold**, *italic*,
 * _italic_, __underline__, ~~strike~~, ||spoiler||, links, and 7TV emotes (as whole words
 * like on Twitch, or as :name:).
 */

type Inline = { re: RegExp; render: (m: RegExpExecArray, ctx: Ctx, key: number) => ReactNode };

interface Ctx {
  emotes: Map<string, Emote>;
  jumbo: boolean;
}

export function EmoteImage({ emote, size, className }: { emote: Emote; size: number; className?: string }) {
  const width = Math.round((emote.width / emote.height) * size);
  return (
    <img
      src={emoteUrl(emoteSource(emote), 1)}
      srcSet={emoteSrcSet(emoteSource(emote))}
      alt={emote.name}
      title={emote.name}
      draggable={false}
      loading="lazy"
      decoding="async"
      width={width}
      height={size}
      className={className ?? "inline-block align-middle"}
      style={{ height: size, width }}
    />
  );
}

const INLINE: Inline[] = [
  { re: /`([^`\n]+)`/, render: (m, _c, k) => <code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{m[1]}</code> },
  { re: /\|\|([\s\S]+?)\|\|/, render: (m, c, k) => <Spoiler key={k}>{inline(m[1], c)}</Spoiler> },
  { re: /\*\*([\s\S]+?)\*\*/, render: (m, c, k) => <strong key={k}>{inline(m[1], c)}</strong> },
  { re: /__([\s\S]+?)__/, render: (m, c, k) => <u key={k}>{inline(m[1], c)}</u> },
  { re: /~~([\s\S]+?)~~/, render: (m, c, k) => <s key={k}>{inline(m[1], c)}</s> },
  { re: /(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/, render: (m, c, k) => <em key={k}>{inline(m[1], c)}</em> },
  { re: /(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)/, render: (m, c, k) => <em key={k}>{inline(m[1], c)}</em> },
  {
    re: /https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"]/,
    render: (m, _c, k) => (
      <a key={k} href={m[0]} target="_blank" rel="noreferrer noopener" className="text-sky-400 hover:underline">
        {m[0]}
      </a>
    ),
  },
];

function Spoiler({ children }: { children: ReactNode }) {
  return (
    <span
      className="cursor-pointer rounded bg-black/70 px-0.5 text-transparent transition-colors [&.open]:bg-white/10 [&.open]:text-inherit"
      onClick={(e) => e.currentTarget.classList.add("open")}
    >
      {children}
    </span>
  );
}

function emotify(text: string, ctx: Ctx, keyBase: string): ReactNode[] {
  if (ctx.emotes.size === 0) return [text];
  const out: ReactNode[] = [];
  // Split on whitespace but keep it, so spacing is preserved.
  const parts = text.split(/(\s+)/);
  let buf = "";
  parts.forEach((p, i) => {
    const name = p.startsWith(":") && p.endsWith(":") && p.length > 2 ? p.slice(1, -1) : p;
    const e = ctx.emotes.get(name);
    if (e) {
      if (buf) out.push(buf);
      buf = "";
      out.push(<EmoteImage key={`${keyBase}-${i}`} emote={e} size={ctx.jumbo ? 48 : 28} className="mx-px inline-block align-middle" />);
    } else {
      buf += p;
    }
  });
  if (buf) out.push(buf);
  return out;
}

function inline(text: string, ctx: Ctx): ReactNode[] {
  let best: { m: RegExpExecArray; rule: Inline } | null = null;
  for (const rule of INLINE) {
    const m = rule.re.exec(text);
    if (m && (!best || m.index < best.m.index)) best = { m, rule };
  }
  if (!best) return emotify(text, ctx, text.length.toString());
  const { m, rule } = best;
  return [
    ...emotify(text.slice(0, m.index), ctx, `a${m.index}`),
    rule.render(m, ctx, m.index),
    ...inline(text.slice(m.index + m[0].length), ctx),
  ];
}

const EMOTE_ONLY = /^\s*(\S+\s*){1,27}$/;

export const Markup = memo(function Markup({ content, emotes }: { content: string; emotes: Map<string, Emote> }) {
  // A message made only of emotes renders them large.
  const words = content.trim().split(/\s+/);
  const jumbo =
    EMOTE_ONLY.test(content) &&
    words.every((w) => emotes.has(w) || (w.startsWith(":") && w.endsWith(":") && emotes.has(w.slice(1, -1))));
  const ctx: Ctx = { emotes, jumbo };

  const blocks = content.split(/```(?:([\w+-]+)\n)?([\s\S]*?)```/);
  // split with 2 capture groups yields [text, lang, code, text, lang, code, ...]
  const nodes: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i += 3) {
    const text = blocks[i];
    if (text) {
      text.split("\n").forEach((line, li, arr) => {
        const quote = line.startsWith("> ");
        const body = inline(quote ? line.slice(2) : line, ctx);
        nodes.push(
          quote ? (
            <span key={`${i}-${li}`} className="block border-l-4 border-muted-foreground/40 pl-3">{body}</span>
          ) : (
            <Fragment key={`${i}-${li}`}>
              {body}
              {li < arr.length - 1 && <br />}
            </Fragment>
          ),
        );
      });
    }
    if (i + 2 < blocks.length) {
      nodes.push(
        <pre key={`code-${i}`} className="selectable my-1 overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono text-[0.85em] whitespace-pre-wrap">
          {blocks[i + 2].replace(/\n$/, "")}
        </pre>,
      );
    }
  }
  return <>{nodes}</>;
});
