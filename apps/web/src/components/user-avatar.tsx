import type { Status, User } from "@app/protocol";
import { memo } from "react";

import { cn } from "@/lib/utils";

const COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#ed4245", "#eb459e", "#00a8fc", "#9b59b6", "#1abc9c"];

export function userColor(id: string) {
  let h = 0;
  for (let i = id.length - 4; i < id.length; i++) h = h * 31 + id.charCodeAt(i);
  return COLORS[Math.abs(h) % COLORS.length];
}

const statusColor: Record<Status, string> = {
  online: "bg-online",
  idle: "bg-idle",
  dnd: "bg-dnd",
  offline: "bg-muted-foreground",
};

export const UserAvatar = memo(function UserAvatar({
  user,
  size = 32,
  status,
  speaking,
  className,
}: {
  user: User;
  size?: number;
  status?: Status;
  speaking?: boolean;
  className?: string;
}) {
  const dot = Math.max(10, Math.round(size * 0.32));
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <div
        className={cn(
          "grid size-full place-items-center overflow-hidden rounded-full font-semibold text-white transition-shadow",
          speaking && "ring-2 ring-online ring-offset-2 ring-offset-background",
        )}
        style={{ background: user.avatarUrl ? undefined : userColor(user.id), fontSize: size * 0.4 }}
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="size-full object-cover" loading="lazy" draggable={false} />
        ) : (
          user.displayName.slice(0, 1).toUpperCase()
        )}
      </div>
      {status && (
        <span
          className={cn("absolute -right-0.5 -bottom-0.5 rounded-full border-[3px] border-sidebar", statusColor[status])}
          style={{ width: dot, height: dot }}
        />
      )}
    </div>
  );
});
