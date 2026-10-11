import type { Emote } from "@app/protocol";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { EmoteImage } from "@/components/chat/markup";
import { Input } from "@/components/ui/input";
import { useApp } from "@/stores/app";

const EMOJI = "😀 😂 🤣 😊 😍 🥰 😎 🤔 😐 🙄 😴 😭 😡 🤯 🥳 😱 🤡 💀 👻 👀 👍 👎 👏 🙏 💪 🔥 ✨ 💯 ❤️ 💔 🎉 ✅ ❌ ⭐ 🌟 🎮 🕹️ 🏆 🍕 🍺 ☕ 🚀 💎 🐐 🧠 🫡 🤝 👋 🤷".split(" ");

/** Picker for guild 7TV emotes and a small set of unicode emoji. */
export function EmojiPicker({ guildId, onPick }: { guildId: string; onPick: (value: { emote?: Emote; emoji?: string }) => void }) {
  const emotes = useApp(useShallow((s) => s.emotes[guildId] ?? []));
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ql ? emotes.filter((e) => e.name.toLowerCase().includes(ql)) : emotes;
  }, [emotes, q]);
  return (
    <div className="flex h-80 w-80 flex-col gap-2">
      <Input autoFocus placeholder="Find the perfect emote" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length > 0 && <div className="px-1 pb-1 text-xs font-semibold text-muted-foreground uppercase">Server emotes</div>}
        <div className="grid grid-cols-7 gap-1">
          {filtered.slice(0, 300).map((e) => (
            <button key={e.id} className="grid h-10 place-items-center rounded hover:bg-accent" title={e.name} onClick={() => onPick({ emote: e })}>
              <EmoteImage emote={e} size={28} className="max-w-9 object-contain" />
            </button>
          ))}
        </div>
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
