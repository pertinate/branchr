import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Dialogs any menu can open; rendered once by `GlobalDialogs`, for `instanceId`. */
export type DialogState = { instanceId: string } & (
  | { kind: "invite"; guildId: string }
  | { kind: "guild-settings"; guildId: string; tab: "overview" | "roles" | "emotes" | "bans" | "audit" | "webhooks" }
  | { kind: "ban"; guildId: string; userId: string }
  | { kind: "nickname"; guildId: string }
  | { kind: "create-channel"; guildId: string; parentId: string | null }
  | { kind: "edit-channel"; channelId: string }
  | { kind: "host-admin" }
);

export const useDialogs = create<{ dialog: DialogState | null; open: (d: DialogState) => void; close: () => void }>()((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

/** Per-device UI preferences. */
export const usePrefs = create<{ devMode: boolean; set: (p: Partial<{ devMode: boolean }>) => void }>()(
  persist((set) => ({ devMode: false, set: (p) => set(p) }), { name: "prefs" }),
);
