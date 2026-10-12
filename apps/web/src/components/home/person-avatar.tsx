import type { Person, User } from "@app/protocol";

import { UserAvatar } from "@/components/user-avatar";
import { useSocial } from "@/lib/social";

/** A branchr person as the `User` shape avatars and markup take. */
export const asUser = (p: Person): User => ({ id: p.id, username: p.handle, displayName: p.displayName, avatarUrl: p.avatarUrl, globalId: p.id, bot: false });

/** Avatar with a presence dot for friends. */
export function PersonAvatar({ person, size = 32 }: { person: Person; size?: number }) {
  const online = useSocial((s) => !!s.online[person.id]);
  const friend = useSocial((s) => s.relationships[person.id]?.kind === "friend");
  return <UserAvatar user={asUser(person)} size={size} status={friend ? (online ? "online" : "offline") : undefined} />;
}
