import type { Emote, User } from "@app/protocol";
import { Fragment, type ReactNode, memo, useMemo } from "react";

import { EMOTE_TOKEN, emoteSource, emoteSrcSet, emoteUrl } from "@/lib/emotes";
import { EVERYONE_MENTION, ROLE_MENTION, USER_MENTION } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useEmoteCard } from "@/stores/emotes";

/**
 * Discord-flavoured markdown subset: ```code blocks```, `inline code`, **bold**, *italic*,
 * _italic_, __underline__, ~~strike~~, ||spoiler||, links, and emotes: this server's as
 * :name:, any server's as <:name:id> tokens resolved from the message's emote snapshot,
 * and mentions (<@id>, <@&role>, @everyone, @here).
 */

type Inline = { re: RegExp; render: (m: RegExpExecArray, ctx: Ctx, key: number) => ReactNode };

interface Ctx {
  emotes: Map<string, Emote>;
  /** Emotes referenced by id (<:name:id>). */
  byId: Map<string, Emote>;
  jumbo: boolean;
  guildId?: string;
  /** Users the message mentions, snapshotted when sent. */
  mentions: Map<string, User>;
  /** Whether @everyone / @here actually pinged (the author may not be allowed to). */
  everyone: boolean;
}

const PILL = "rounded-sm bg-primary/25 px-0.5 font-medium text-[oklch(0.86_0.08_265)] hover:bg-primary/60 hover:text-white";

/** `@name`, live from the member list so nick changes show; the snapshot covers people who left. */
function Mention({ id, ctx }: { id: string; ctx: Ctx }) {
  const name = useApp((s) => {
    const m = ctx.guildId ? s.members[ctx.guildId]?.[id] : undefined;
    return m?.nick ?? m?.user.displayName ?? ctx.mentions.get(id)?.displayName ?? "unknown-user";
  });
  return (
    <span data-mention={id} className={cn(PILL, "cursor-default")}>
      @{name}
    </span>
  );
}

export function EmoteImage({ emote, size, className, interactive }: { emote: Emote; size: number; className?: string; interactive?: boolean }) {
  const width = Math.round((emote.width / emote.height) * size);
  return (
    <img
      onClick={interactive ? (e) => useEmoteCard.getState().open(emote, e.currentTarget) : undefined}
      data-emote-id={emote.id}
      src={emoteUrl(emoteSource(emote), 1)}
      srcSet={emoteSrcSet(emoteSource(emote))}
      alt={emote.name}
      title={emote.name}
      draggable={false}
      loading="lazy"
      decoding="async"
      width={width}
      height={size}
      className={cn(className ?? "inline-block align-middle", interactive && "cursor-pointer")}
      style={{ height: size, width }}
    />
  );
}

function emoteEl(e: Emote, ctx: Ctx, key: string | number) {
  return <EmoteImage key={key} emote={e} size={ctx.jumbo ? 48 : 28} interactive className="mx-px inline-block align-middle" />;
}

const INLINE: Inline[] = [
  {
    re: new RegExp(EMOTE_TOKEN.source),
    render: (m, c, k) => {
      const e = c.byId.get(m[2]);
      return e ? emoteEl(e, c, k) : `:${m[1]}:`;
    },
  },
  { re: USER_MENTION, render: (m, c, k) => <Mention key={k} id={m[1]} ctx={c} /> },
  { re: ROLE_MENTION, render: (_m, _c, k) => <span key={k} className={PILL}>@unknown-role</span> },
  {
    re: EVERYONE_MENTION,
    render: (m, c, k) =>
      c.everyone ? (
        <span key={k} data-mention={m[1]} className={PILL}>
          @{m[1]}
        </span>
      ) : (
        m[0]
      ),
  },
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

const NAMED_EMOTE = /:([\w!?-]{1,64}):/g;

/** `:name:` → this server's emote. Bare words are never converted: emotes are intentional. */
function emotify(text: string, ctx: Ctx, keyBase: string): ReactNode[] {
  if (ctx.emotes.size === 0 || !text.includes(":")) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(NAMED_EMOTE)) {
    const e = ctx.emotes.get(m[1]);
    if (!e) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(emoteEl(e, ctx, `${keyBase}-${m.index}`));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
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

const WHOLE_TOKEN = new RegExp(`^${EMOTE_TOKEN.source}$`);

export const Markup = memo(function Markup({
  content,
  emotes,
  refs,
  guildId,
  mentions: mentioned,
  everyone = false,
}: {
  content: string;
  emotes: Map<string, Emote>;
  refs?: Emote[];
  guildId?: string;
  mentions?: User[];
  everyone?: boolean;
}) {
  const byId = useMemo(() => new Map((refs ?? []).map((e) => [e.id, e])), [refs]);
  const mentions = useMemo(() => new Map((mentioned ?? []).map((u) => [u.id, u])), [mentioned]);
  // A message made only of emotes renders them large.
  const words = content.trim().split(/\s+/);
  const jumbo =
    EMOTE_ONLY.test(content) &&
    words.every(
      (w) =>
        (w.startsWith(":") && w.endsWith(":") && emotes.has(w.slice(1, -1))) ||
        byId.has(WHOLE_TOKEN.exec(w)?.[2] ?? ""),
    );
  const ctx: Ctx = { emotes, byId, jumbo, guildId, mentions, everyone };

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
