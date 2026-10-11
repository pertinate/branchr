/**
 * Several self-hosted branchr instances at once.
 *
 * Each instance we're logged in to gets its own stores, API client and gateway, all live at
 * once (so other instances keep their unread badges, notifications and voice). Components
 * under an instance's route read its stores through `InstanceContext`; code outside React
 * (handlers, libs) acts on the *active* instance, which follows the route.
 *
 * "Instance" in code = a self-hosted deployment. The UI calls guilds "servers", like Discord.
 */
import type { User } from "@app/protocol";
import { createContext, createElement, type ReactNode, useContext } from "react";
import { type StoreApi, type UseBoundStore, create, useStore } from "zustand";
import { persist } from "zustand/middleware";

import { type Api, createApi } from "@/lib/api";
import { Gateway } from "@/lib/gateway";
import { type AppStore, createAppStore } from "@/stores/app";
import { type AuthState, createAuthStore } from "@/stores/auth";
import { type MessagesStore, createMessagesStore } from "@/stores/messages";

export interface Session {
  id: string;
  url: string;
  token: string;
  user: User;
}

export interface Instance {
  /** Route-safe key from the address, e.g. `chat.example.com`, `localhost-8080`. */
  id: string;
  url: string;
  auth: UseBoundStore<StoreApi<AuthState>>;
  app: AppStore;
  messages: MessagesStore;
  gateway: Gateway;
  api: Api;
}

export function instanceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, "").replace(/[^a-zA-Z0-9.]+/g, "-").toLowerCase();
  } catch {
    return url.replace(/[^a-zA-Z0-9.]+/g, "-").toLowerCase();
  }
}

/** An instance's address for people: host and port, e.g. `chat.example.com`. */
export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** The address the login screen suggests: this page's own server when served by one. */
export const defaultServerUrl =
  typeof window !== "undefined" && window.location.protocol.startsWith("http") && !import.meta.env.DEV ? window.location.origin : "http://localhost:8080";

// Before multiple instances, one session lived under "auth" and read state under "lastRead".
function migrateSingleSession() {
  try {
    if (localStorage.getItem("sessions") || !localStorage.getItem("auth")) return;
    const old = JSON.parse(localStorage.getItem("auth") ?? "{}").state;
    if (!old?.token || !old.serverUrl) return;
    const url = normalizeUrl(old.serverUrl);
    const id = instanceKey(url);
    localStorage.setItem("sessions", JSON.stringify({ state: { sessions: [{ id, url, token: old.token, user: old.user }] }, version: 0 }));
    for (const key of ["lastRead", "lastChannel"]) {
      const v = localStorage.getItem(key);
      if (v) localStorage.setItem(`${key}:${id}`, v);
    }
  } catch {
    /* start clean */
  }
}
migrateSingleSession();

interface SessionsState {
  sessions: Session[];
  /** Adds or refreshes a login; returns the instance id. */
  add: (url: string, token: string, user: User) => string;
  setUser: (id: string, user: User) => void;
  remove: (id: string) => void;
}

export const useSessions = create<SessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
      add: (url, token, user) => {
        url = normalizeUrl(url);
        const id = instanceKey(url);
        const rest = get().sessions.filter((s) => s.id !== id);
        const at = get().sessions.findIndex((s) => s.id === id);
        const next = { id, url, token, user };
        // Keep its place when logging in again; new instances go last.
        set({ sessions: at === -1 ? [...rest, next] : [...rest.slice(0, at), next, ...rest.slice(at)] });
        return id;
      },
      setUser: (id, user) => set({ sessions: get().sessions.map((s) => (s.id === id ? { ...s, user } : s)) }),
      remove: (id) => set({ sessions: get().sessions.filter((s) => s.id !== id) }),
    }),
    { name: "sessions", partialize: (s) => ({ sessions: s.sessions }) as SessionsState },
  ),
);

/** The instance handlers act on: the one the current route shows. */
export const useActive = create<{ id: string | null }>()(() => ({ id: null }));

const live = new Map<string, Instance>();
let started = false;
/** Bumps when instances come or go, for things that list them. */
export const useInstanceList = create<{ ids: string[] }>()(() => ({ ids: [] }));

function build(session: { id: string; url: string } | null): Instance {
  const inst = { id: session?.id ?? "", url: session?.url ?? defaultServerUrl } as Instance;
  inst.auth = createAuthStore(inst);
  inst.api = createApi(inst);
  inst.messages = createMessagesStore(inst);
  inst.app = createAppStore(inst);
  inst.gateway = new Gateway(inst);
  return inst;
}

let placeholder: Instance | null = null;
/** Stands in when we're logged in nowhere (the login screen); never connects. */
function none(): Instance {
  return (placeholder ??= build(null));
}

/** Keeps live instances in step with saved sessions. */
function sync() {
  const sessions = useSessions.getState().sessions;
  for (const s of sessions) {
    let inst = live.get(s.id);
    if (!inst) {
      inst = build(s);
      live.set(s.id, inst);
      if (started) inst.gateway.start();
    }
    const a = inst.auth.getState();
    if (a.token !== s.token || a.user !== s.user) inst.auth.setState({ token: s.token, user: s.user });
  }
  for (const [id, inst] of live) {
    if (sessions.some((s) => s.id === id)) continue;
    inst.gateway.stop();
    live.delete(id);
  }
  const ids = sessions.map((s) => s.id);
  if (ids.join() !== useInstanceList.getState().ids.join()) useInstanceList.setState({ ids });
  const active = useActive.getState().id;
  if (!active || !live.has(active)) useActive.setState({ id: ids[0] ?? null });
}
let synced = false;
function ensureSynced() {
  if (synced) return;
  synced = true;
  sync();
  useSessions.subscribe(sync);
}

export function instance(id: string | null | undefined): Instance | undefined {
  ensureSynced();
  return id ? live.get(id) : undefined;
}

/** All instances we're logged in to, in rail order. */
export function instances(): Instance[] {
  ensureSynced();
  return useSessions
    .getState()
    .sessions.map((s) => live.get(s.id))
    .filter((i): i is Instance => !!i);
}

export function activeInstance(): Instance {
  ensureSynced();
  return instance(useActive.getState().id) ?? instances()[0] ?? none();
}

/** Connects every instance (and any added later). Returns a function that disconnects them. */
export function startInstances(): () => void {
  ensureSynced();
  started = true;
  for (const i of live.values()) i.gateway.start();
  return () => {
    started = false;
    for (const i of live.values()) i.gateway.stop();
  };
}

const InstanceContext = createContext<Instance | null>(null);

/** Renders `children` against `instance`'s stores. */
export function InstanceProvider({ instance: inst, children }: { instance: Instance; children: ReactNode }) {
  return createElement(InstanceContext.Provider, { value: inst }, children);
}

/** The instance this component belongs to: its provider's, else the active one. */
export function useInstance(): Instance {
  const ctx = useContext(InstanceContext);
  const activeId = useActive((s) => s.id);
  if (ctx) return ctx;
  ensureSynced();
  return instance(activeId) ?? instances()[0] ?? none();
}

type Proxied<S> = (<T>(selector: (s: S) => T) => T) & {
  getState: () => S;
  setState: StoreApi<S>["setState"];
  subscribe: StoreApi<S>["subscribe"];
};

/**
 * A store that stands for "this instance's": as a hook it follows `useInstance()`; its
 * `getState`/`setState`/`subscribe` act on the active instance.
 */
export function instanceStore<S>(pick: (i: Instance) => StoreApi<S>): Proxied<S> {
  function useProxied<T>(selector: (s: S) => T): T {
    return useStore(pick(useInstance()), selector);
  }
  useProxied.getState = () => pick(activeInstance()).getState();
  useProxied.setState = ((...args: Parameters<StoreApi<S>["setState"]>) => pick(activeInstance()).setState(...args)) as StoreApi<S>["setState"];
  useProxied.subscribe = ((l: Parameters<StoreApi<S>["subscribe"]>[0]) => pick(activeInstance()).subscribe(l)) as StoreApi<S>["subscribe"];
  return useProxied;
}
