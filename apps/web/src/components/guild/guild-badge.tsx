import type { Guild } from "@app/protocol";

import { useMediaUrl } from "@/lib/media";
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
  const icon = useMediaUrl(guild.iconUrl);
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center overflow-hidden rounded bg-muted text-[8px] font-semibold", className)}>
      {icon ? <img src={icon} alt="" className="size-full object-cover" /> : guildInitials(guild.name)}
    </span>
  );
}
