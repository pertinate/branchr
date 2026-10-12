/**
 * Friends and direct messages, from branchr ID (not any one host). Connected whenever you're
 * signed in to branchr: a gateway for live events, and REST for everything else.
 */
import type { DmChannel, DmMessage, Person, Relationship, SocialEvent, SocialOp } from "@app/protocol";
import { create } from "zustand";

import { ID_URL, accessToken, useBranchrId } from "@/lib/branchr-id";
import { compareIds, nonce } from "@/lib/ids";

export type UiDm = DmMessage & { pending?: boolean; failed?: boolean };

interface Thread {
  items: UiDm[];
  hasMore: boolean;
  loaded: boolean;
}

export interface SocialState {
  status: "off" | "connecting" | "ready";
  me: Person | null;
  relationships: Record<string, Relationship>;
  /** Friends online now. */
  online: Record<string, true>;
  channels: Record<string, DmChannel>;
  threads: Record<string, Thread>;
  /** channel id -> person id -> typing until (ms) */
  typing: Record<string, Record<string, number>>;
  /** The DM on screen. */
  viewing: string | null;
}

const initial: SocialState = { status: "off", me: null, relationships: {}, online: {}, channels: {}, threads: {}, typing: {}, viewing: null };

export const useSocial = create<SocialState>()(() => initial);

const set = useSocial.setState;
const get = useSocial.getState;

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _, ...rest } = rec;
  return rest;
}

function insertSorted(items: UiDm[], m: UiDm): UiDm[] {
  const i = items.findIndex((x) => !x.pending && compareIds(x.id, m.id) > 0);
  return i === -1 ? [...items, m] : [...items.slice(0, i), m, ...items.slice(i)];
}

function patchThread(cid: string, f: (t: Thread) => Thread) {
  set((s) => ({ threads: { ...s.threads, [cid]: f(s.threads[cid] ?? { items: [], hasMore: true, loaded: false }) } }));
}

/** Whether a DM has messages we haven't read. */
export function isUnread(c: DmChannel): boolean {
  return !!c.lastMessageId && (!c.lastReadId || compareIds(c.lastMessageId, c.lastReadId) > 0);
}

function apply(ev: SocialEvent) {
  switch (ev.t) {
    case "READY": {
      const d = ev.d;
      set({
        status: "ready",
        me: d.me,
        relationships: Object.fromEntries(d.relationships.map((r) => [r.person.id, r])),
        online: Object.fromEntries(d.online.map((id) => [id, true as const])),
        channels: Object.fromEntries(d.channels.map((c) => [c.id, c])),
        // Threads reload on view; what we had may have missed events while away.
        threads: {},
      });
      return;
    }
    case "RELATIONSHIP_UPDATE":
      set((s) => ({ relationships: { ...s.relationships, [ev.d.person.id]: ev.d } }));
      return;
    case "RELATIONSHIP_REMOVE":
      set((s) => ({ relationships: without(s.relationships, ev.d.id), online: without(s.online, ev.d.id) }));
      return;
    case "PRESENCE_UPDATE":
      set((s) => ({ online: ev.d.online ? { ...s.online, [ev.d.id]: true } : without(s.online, ev.d.id) }));
      return;
    case "PERSON_UPDATE":
      set((s) => {
        const r = s.relationships[ev.d.id];
        return r ? { relationships: { ...s.relationships, [ev.d.id]: { ...r, person: ev.d } } } : {};
      });
      return;
    case "DM_CHANNEL_CREATE":
      set((s) => ({ channels: { ...s.channels, [ev.d.id]: ev.d } }));
      return;
    case "DM_MESSAGE_CREATE": {
      const m = ev.d;
      set((s) => {
        const c = s.channels[m.channelId];
        const mine = m.author.id === s.me?.id;
        const seen = mine || (s.viewing === m.channelId && document.visibilityState === "visible");
        const typing = s.typing[m.channelId]?.[m.author.id] ? { ...s.typing, [m.channelId]: without(s.typing[m.channelId], m.author.id) } : s.typing;
        return c ? { channels: { ...s.channels, [c.id]: { ...c, lastMessageId: m.id, lastReadId: seen ? m.id : c.lastReadId } }, typing } : { typing };
      });
      if (get().viewing === m.channelId && m.author.id !== get().me?.id) ack(m.channelId);
      if (!get().threads[m.channelId]) return;
      patchThread(m.channelId, (t) => {
        const pending = m.nonce ? t.items.findIndex((x) => x.nonce === m.nonce && x.pending) : -1;
        const rest = pending === -1 ? t.items : t.items.filter((_, i) => i !== pending);
        if (rest.some((x) => x.id === m.id)) return t;
        return { ...t, items: insertSorted(rest, { ...m }) };
      });
      return;
    }
    case "DM_MESSAGE_UPDATE":
      patchThread(ev.d.channelId, (t) => ({ ...t, items: t.items.map((x) => (x.id === ev.d.id ? { ...ev.d } : x)) }));
      return;
    case "DM_MESSAGE_DELETE":
      patchThread(ev.d.channelId, (t) => ({ ...t, items: t.items.filter((x) => x.id !== ev.d.id) }));
      return;
    case "DM_TYPING":
      set((s) => ({ typing: { ...s.typing, [ev.d.channelId]: { ...s.typing[ev.d.channelId], [ev.d.userId]: Date.now() + 8000 } } }));
      return;
    case "HEARTBEAT_ACK":
      return;
  }
}

// ---- Gateway ----

let ws: WebSocket | null = null;

function sendOp(op: SocialOp) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(op));
}

/** Keeps the gateway up while signed in to branchr. Returns a stop function. */
export function startSocial(): () => void {
  let stopped = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;

  const connect = async () => {
    if (stopped || ws || !useBranchrId.getState().account) return;
    set({ status: "connecting" });
    const token = await accessToken().catch(() => null);
    if (!token || stopped) {
      set({ status: "off" });
      return;
    }
    const sock = new WebSocket(`${ID_URL.replace(/^http/, "ws")}/gateway`);
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ op: "identify", d: { token } } satisfies SocialOp));
    sock.onmessage = (e) => {
      const ev = JSON.parse(e.data as string) as SocialEvent;
      if (ev.t === "READY") retry = 0;
      apply(ev);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (stopped || !useBranchrId.getState().account) {
        set(initial);
        return;
      }
      set({ status: "connecting" });
      // Back off, up to half a minute.
      timer = setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** retry++));
    };
  };

  beat = setInterval(() => sendOp({ op: "heartbeat" }), 30_000);
  const typingSweep = setInterval(() => {
    const now = Date.now();
    const { typing } = get();
    let changed = false;
    const next: SocialState["typing"] = {};
    for (const [cid, people] of Object.entries(typing)) {
      const kept = Object.fromEntries(Object.entries(people).filter(([, until]) => until > now));
      if (Object.keys(kept).length !== Object.keys(people).length) changed = true;
      if (Object.keys(kept).length) next[cid] = kept;
    }
    if (changed) set({ typing: next });
  }, 1000);
  // Signing in or out of branchr starts or ends it.
  const unsub = useBranchrId.subscribe((s, prev) => {
    if (!!s.account === !!prev.account) return;
    if (s.account) void connect();
    else {
      ws?.close();
      ws = null;
      set(initial);
    }
  });
  void connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(beat);
    clearInterval(typingSweep);
    unsub();
    ws?.close();
    ws = null;
  };
}

// ---- REST ----

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new Error("Sign in to branchr first");
  const r = await fetch(`${ID_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const e = await r.json();
      msg = e.error_description ?? e.error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const addFriend = (handle: string) => call<void>("POST", "/relationships", { handle });
export const acceptFriend = (id: string) => call<void>("PUT", `/relationships/${id}`, { kind: "friend" });
export const blockPerson = (id: string) => call<void>("PUT", `/relationships/${id}`, { kind: "blocked" });
/** Unfriend, cancel, decline or unblock. */
export const removeRelationship = (id: string) => call<void>("DELETE", `/relationships/${id}`);

/** The DM with someone (created if needed), now in the list. */
export async function openDm(personId: string): Promise<DmChannel> {
  const c = await call<DmChannel>("POST", "/dms", { recipient: personId });
  set((s) => ({ channels: { ...s.channels, [c.id]: c } }));
  return c;
}

const PAGE = 50;

export async function loadThread(cid: string, older = false) {
  const t = get().threads[cid];
  if (older && (!t?.hasMore || !t.items.length)) return;
  const before = older ? t!.items.find((x) => !x.pending)?.id : undefined;
  const page = await call<DmMessage[]>("GET", `/dms/${cid}/messages?limit=${PAGE}${before ? `&before=${before}` : ""}`);
  patchThread(cid, (t) => ({
    items: older ? [...page, ...t.items] : [...page, ...t.items.filter((x) => x.pending || x.failed)],
    hasMore: page.length === PAGE,
    loaded: true,
  }));
}

export async function sendDm(cid: string, content: string) {
  const me = get().me;
  if (!me) return;
  const n = nonce();
  const optimistic: UiDm = { id: `pending-${n}`, channelId: cid, author: me, content, editedAt: null, replyTo: null, nonce: n, pending: true };
  patchThread(cid, (t) => ({ ...t, items: [...t.items, optimistic] }));
  try {
    const m = await call<DmMessage>("POST", `/dms/${cid}/messages`, { content, nonce: n });
    apply({ t: "DM_MESSAGE_CREATE", d: m });
  } catch (e) {
    patchThread(cid, (t) => ({ ...t, items: t.items.map((x) => (x.nonce === n ? { ...x, pending: false, failed: true } : x)) }));
    throw e;
  }
}

export const editDm = (cid: string, mid: string, content: string) => call<DmMessage>("PATCH", `/dms/${cid}/messages/${mid}`, { content });
export const deleteDm = (cid: string, mid: string) => call<void>("DELETE", `/dms/${cid}/messages/${mid}`);

export function ack(cid: string) {
  const c = get().channels[cid];
  if (!c?.lastMessageId || !isUnread(c) || document.visibilityState === "hidden") return;
  set((s) => ({ channels: { ...s.channels, [cid]: { ...c, lastReadId: c.lastMessageId } } }));
  sendOp({ op: "ack", d: { channelId: cid, messageId: c.lastMessageId } });
}

let lastTyping = 0;
export function typing(cid: string) {
  if (Date.now() - lastTyping < 6000) return;
  lastTyping = Date.now();
  sendOp({ op: "typing", d: { channelId: cid } });
}

export function setViewing(cid: string | null) {
  set({ viewing: cid });
}
