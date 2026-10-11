import { cn } from "@/lib/utils";

/** Red count of unread mentions. */
export function MentionBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      data-testid="mention-badge"
      aria-label={`${count} mention${count === 1 ? "" : "s"}`}
      className={cn("grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[11px] leading-none font-bold text-white box-content", className)}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
