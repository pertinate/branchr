import type { User } from "@app/protocol";
import { create } from "zustand";

import { type Instance, instanceStore, useActive, useSessions } from "@/lib/instances";

export interface AuthState {
  serverUrl: string;
  token: string | null;
  user: User | null;
  /** Logs in to `serverUrl` (adding it as an instance if new) and switches to it. */
  setSession: (serverUrl: string, token: string, user: User) => void;
  setUser: (user: User) => void;
  /** Logs out of this instance only. */
  logout: () => void;
}

export function createAuthStore(inst: Instance) {
  const saved = useSessions.getState().sessions.find((s) => s.id === inst.id);
  return create<AuthState>()(() => ({
    serverUrl: inst.url,
    token: saved?.token ?? null,
    user: saved?.user ?? null,
    setSession: (serverUrl, token, user) => {
      const id = useSessions.getState().add(serverUrl, token, user);
      useActive.setState({ id });
    },
    setUser: (user) => {
      if (inst.id) useSessions.getState().setUser(inst.id, user);
    },
    logout: () => {
      if (inst.id) useSessions.getState().remove(inst.id);
    },
  }));
}

/** This instance's login (see `useInstance`). */
export const useAuth = instanceStore((i) => i.auth);
