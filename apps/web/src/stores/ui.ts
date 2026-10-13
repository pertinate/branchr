import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Status } from "@app/protocol";

/** Dialogs any menu can open; rendered once by `GlobalDialogs`, for `instanceId`. */
export type DialogState = { instanceId: string } & (
  | { kind: "invite"; guildId: string }
  | { kind: "guild-settings"; guildId: string; tab: "overview" | "roles" | "emotes" | "bans" | "audit" | "webhooks" }
  | { kind: "ban"; guildId: string; userId: string }
  | { kind: "nickname"; guildId: string }
  | { kind: "create-channel"; guildId: string; parentId: string | null; channelKind?: "text" | "voice" | "category" }
  | { kind: "create-thread"; channelId: string; messageId?: string; suggested: string }
  | { kind: "edit-channel"; channelId: string }
  | { kind: "host-admin" }
  | { kind: "custom-status" }
);

export const useDialogs = create<{ dialog: DialogState | null; open: (d: DialogState) => void; close: () => void }>()((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

/**
 * The status you chose and your custom status, the same on every hub. Kept on this device
 * and sent when connecting, so a reload or reconnect doesn't reset them.
 */
export const useMyStatus = create<{ status: Status; custom: string; away: boolean }>()(
  persist(() => ({ status: "online" as Status, custom: "", away: false as boolean }), { name: "my-status", partialize: ({ status, custom }) => ({ status, custom }) }),
);

/** What others see: online turns idle while you're away. */
export const shownStatus = (s: { status: Status; away: boolean }): Status => (s.away && s.status === "online" ? "idle" : s.status);

/** Per-device UI preferences. */
export const usePrefs = create<{ devMode: boolean; set: (p: Partial<{ devMode: boolean }>) => void }>()(
  persist((set) => ({ devMode: false, set: (p) => set(p) }), { name: "prefs" }),
);
