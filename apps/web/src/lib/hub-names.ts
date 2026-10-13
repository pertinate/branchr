/**
 * Hubs by what people call them. Addresses can look alike (two "overseers" on different
 * gateways, the same name on two hubs), so the app shows each hub's name with its branchr
 * key, which is unique, as the tiebreaker.
 */
import { create } from "zustand";

import { hostOf, instance } from "@/lib/instances";
import { instanceInfo } from "@/lib/server-login";

export interface HubLabel {
  name: string;
  /** Its branchr ID key, when it's registered there (unique across every hub). */
  key: string | null;
}

const useHubNames = create<Record<string, HubLabel>>(() => ({}));

/** Fetches a hub's name and key (once it's connected). */
export async function loadHubName(instanceId: string) {
  const inst = instance(instanceId);
  if (!inst) return;
  try {
    const info = await instanceInfo(inst.url);
    useHubNames.setState({ [instanceId]: { name: info.name || hostOf(inst.url), key: info.instanceId ?? null } });
  } catch {
    /* unreachable for now; the address stands in */
  }
}

function fallback(instanceId: string): HubLabel {
  const inst = instance(instanceId);
  return { name: inst ? hostOf(inst.url) : instanceId, key: null };
}

export function hubLabel(instanceId: string): HubLabel {
  return useHubNames.getState()[instanceId] ?? fallback(instanceId);
}

export function useHubLabel(instanceId: string): HubLabel {
  return useHubNames((s) => s[instanceId]) ?? fallback(instanceId);
}

/** A key short enough to read: its first 8 characters. */
export const shortKey = (key: string) => key.replace(/-/g, "").slice(0, 8);
