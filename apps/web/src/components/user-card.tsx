import type { User } from "@app/protocol";
import { useNavigate } from "@tanstack/react-router";
import { MessageCircle, UserCheck, UserPlus } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UserAvatar, userColor } from "@/components/user-avatar";
import { useBranchrId } from "@/lib/branchr-id";
import { hostOf, useInstance } from "@/lib/instances";
import { roleColor } from "@/lib/perms";
import { addFriendById, openDm, useSocial } from "@/lib/social";
import { useApp } from "@/stores/app";

/**
 * Click `children` (a ref-taking element) for `user`'s card. Other props (and the ref) go to
 * the trigger, so it can sit inside another `asChild` trigger, like a context menu's.
 */
export function UserCardPopover({ guildId, user, children, ...trigger }: { guildId?: string; user: User; children: ReactNode } & ComponentProps<typeof PopoverTrigger>) {
  return (
    <Popover>
      <PopoverTrigger asChild {...trigger}>
        {children}
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 overflow-hidden p-0" data-testid="user-card">
        <UserCard guildId={guildId} user={user} />
      </PopoverContent>
    </Popover>
  );
}

function UserCard({ guildId, user }: { guildId?: string; user: User }) {
  const inst = useInstance();
  const navigate = useNavigate();
  const member = useApp((s) => (guildId ? s.members[guildId]?.[user.id] : undefined));
  const roles = useApp(useShallow((s) => (guildId && member ? (s.roles[guildId] ?? []).filter((r) => member.roles.includes(r.id)).reverse() : [])));
  const me = useApp((s) => s.me?.id);
  const signedIn = useBranchrId((s) => !!s.account);
  const myAccount = useSocial((s) => s.me?.id);
  const relation = useSocial((s) => (user.globalId ? s.relationships[user.globalId]?.kind : undefined));
  const live = useApp((s) => s.members[guildId ?? ""]?.[user.id]?.user) ?? user;
  const self = user.id === me;
  const branchr = !!live.globalId && live.globalId !== myAccount;

  const message = async () => {
    try {
      const c = await openDm(live.globalId!);
      void navigate({ to: "/home/$channelId", params: { channelId: c.id } });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const befriend = async () => {
    try {
      await addFriendById(live.globalId!);
      toast.success(`Friend request sent to ${live.displayName}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <div className="h-16" style={{ background: userColor(user.id) }} />
      <div className="-mt-10 px-4 pb-4">
        <div className="w-fit rounded-full border-[6px] border-popover">
          <UserAvatar user={live} size={80} />
        </div>
        <div className="mt-2 text-xl font-semibold">{member?.nick ?? live.displayName}</div>
        <div className="text-sm text-muted-foreground">
          @{live.username} · {hostOf(inst.url)}
        </div>
        {member && (
          <div className="mt-3 text-xs">
            <div className="font-semibold text-muted-foreground uppercase">Member since</div>
            <div>{new Date(member.joinedAt).toLocaleDateString()}</div>
          </div>
        )}
        {roles.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase">Roles</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {roles.map((r) => (
                <span key={r.id} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                  <span className="size-2.5 rounded-full" style={{ background: roleColor(r) ?? "var(--muted-foreground)" }} />
                  {r.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {!self && branchr && signedIn && (
          <div className="mt-4 flex gap-2">
            {relation === "friend" ? (
              <>
                <Button size="sm" className="flex-1" onClick={() => void message()}>
                  <MessageCircle /> Message
                </Button>
                <Button size="sm" variant="secondary" disabled title="Friends">
                  <UserCheck />
                </Button>
              </>
            ) : relation === "outgoing" ? (
              <Button size="sm" variant="secondary" className="flex-1" disabled>
                Friend request sent
              </Button>
            ) : relation === "blocked" ? null : (
              <Button size="sm" className="flex-1" onClick={() => void befriend()}>
                <UserPlus /> {relation === "incoming" ? "Accept Friend Request" : "Add Friend"}
              </Button>
            )}
          </div>
        )}
        {!self && !branchr && (
          <p className="mt-4 text-xs text-muted-foreground">Uses a password account on this branch, so they can't be added as a friend.</p>
        )}
      </div>
    </>
  );
}
