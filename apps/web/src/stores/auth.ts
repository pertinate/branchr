import type { User } from "@app/protocol";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const defaultServer =
  typeof window !== "undefined" && window.location.protocol.startsWith("http") && !import.meta.env.DEV
    ? window.location.origin
    : "http://localhost:8080";

interface AuthState {
  serverUrl: string;
  token: string | null;
  user: User | null;
  setSession: (serverUrl: string, token: string, user: User) => void;
  setUser: (user: User) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      serverUrl: defaultServer,
      token: null,
      user: null,
      setSession: (serverUrl, token, user) => set({ serverUrl: serverUrl.replace(/\/+$/, ""), token, user }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null }),
    }),
    { name: "auth" },
  ),
);
