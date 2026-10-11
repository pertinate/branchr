import type { Guild } from "@app/protocol";

import { cn } from "@/lib/utils";

export function guildInitials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3);
}

/** Small square server icon (image or initials). */
export function GuildBadge({ guild, className }: { guild: Guild; className?: string }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center overflow-hidden rounded bg-muted text-[8px] font-semibold", className)}>
      {guild.iconUrl ? <img src={guild.iconUrl} alt="" className="size-full object-cover" /> : guildInitials(guild.name)}
    </span>
  );
}
