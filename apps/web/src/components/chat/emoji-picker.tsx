import type { Emote } from "@app/protocol";
import { useMemo, useState } from "react";

import { EmoteImage } from "@/components/chat/markup";
import { GuildBadge } from "@/components/guild/guild-badge";
import { Input } from "@/components/ui/input";
import { useEmoteGroups } from "@/stores/emotes";

const EMOJI = "😀 😂 🤣 😊 😍 🥰 😎 🤔 😐 🙄 😴 😭 😡 🤯 🥳 😱 🤡 💀 👻 👀 👍 👎 👏 🙏 💪 🔥 ✨ 💯 ❤️ 💔 🎉 ✅ ❌ ⭐ 🌟 🎮 🕹️ 🏆 🍕 🍺 ☕ 🚀 💎 🐐 🧠 🫡 🤝 👋 🤷".split(" ");
/** Rendered emotes per open picker, to keep huge collections snappy. */
const MAX_SHOWN = 400;

/** Emotes from every server the user is in (this one first) plus a small set of unicode emoji. */
export function EmojiPicker({ guildId, onPick }: { guildId: string; onPick: (value: { emote?: Emote; emoji?: string }) => void }) {
  const groups = useEmoteGroups(guildId);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    let budget = MAX_SHOWN;
    return groups
      .map((g) => {
        const emotes = (ql ? g.emotes.filter((e) => e.name.toLowerCase().includes(ql)) : g.emotes).slice(0, Math.max(budget, 0));
        budget -= emotes.length;
        return { ...g, emotes };
      })
      .filter((g) => g.emotes.length);
  }, [groups, q]);
  return (
    <div className="flex h-96 w-80 flex-col gap-2">
      <Input autoFocus placeholder="Find the perfect emote" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.map(({ guild, emotes }) => (
          <section key={guild.id} aria-label={`${guild.name} emotes`}>
            <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-popover px-1 py-1 text-xs font-semibold text-muted-foreground uppercase">
              <GuildBadge guild={guild} />
              <span className="truncate">{guild.id === guildId ? "This community" : guild.name}</span>
            </div>
            <div className="grid grid-cols-7 gap-1">
              {emotes.map((e) => (
                <button
                  key={e.id}
                  className="grid h-10 place-items-center rounded hover:bg-accent"
                  title={guild.id === guildId ? e.name : `${e.name} (from ${guild.name})`}
                  onClick={() => onPick({ emote: e })}
                >
                  <EmoteImage emote={e} size={28} className="max-w-9 object-contain" />
                </button>
              ))}
            </div>
          </section>
        ))}
        {!q && (
          <>
            <div className="px-1 py-1 text-xs font-semibold text-muted-foreground uppercase">Emoji</div>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI.map((e) => (
                <button key={e} className="grid h-9 place-items-center rounded text-xl hover:bg-accent" onClick={() => onPick({ emoji: e })}>
                  {e}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
