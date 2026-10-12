import type { Person } from "@app/protocol";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { PersonAvatar } from "@/components/home/person-avatar";
import { Input } from "@/components/ui/input";
import { useSocial } from "@/lib/social";

/** Tick friends (except `exclude`), with a filter. */
export function FriendPicker({ picked, onToggle, exclude = [], max }: { picked: string[]; onToggle: (id: string) => void; exclude?: string[]; max: number }) {
  const [filter, setFilter] = useState("");
  const friends = useSocial(
    useShallow((s) =>
      Object.values(s.relationships)
        .filter((r) => r.kind === "friend" && !exclude.includes(r.person.id))
        .map((r) => r.person)
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    ),
  );
  const shown = friends.filter((p: Person) => `${p.displayName} ${p.handle}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="space-y-2">
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type the name of a friend" aria-label="Find a friend" />
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {shown.map((p) => {
          const on = picked.includes(p.id);
          return (
            <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-accent/60">
              <PersonAvatar person={p} size={28} />
              <span className="flex-1 truncate">{p.displayName}</span>
              <span className="text-xs text-muted-foreground">@{p.handle}</span>
              <input type="checkbox" checked={on} disabled={!on && picked.length >= max} onChange={() => onToggle(p.id)} className="accent-primary" aria-label={`Pick ${p.displayName}`} />
            </label>
          );
        })}
        {shown.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No friends to add.</p>}
      </div>
    </div>
  );
}
