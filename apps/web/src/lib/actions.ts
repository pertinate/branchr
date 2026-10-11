/** Actions shared by menus, buttons and shortcuts. */
import { toast } from "sonner";

import { api } from "@/lib/api";
import { useApp } from "@/stores/app";

export async function copy(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
}

async function blobOf(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  return r.blob();
}

/** Puts an image on the clipboard (as PNG, the one image type clipboards take everywhere). */
export async function copyImage(url: string) {
  try {
    const bmp = await createImageBitmap(await blobOf(url));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    const png = await canvas.convertToBlob({ type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast.success("Image copied");
  } catch (e) {
    toast.error("Couldn't copy the image", { description: (e as Error).message });
  }
}

/** Saves a file from another origin (where `<a download>` alone is ignored). */
export async function saveFile(url: string, name: string) {
  try {
    const href = URL.createObjectURL(await blobOf(url));
    const a = Object.assign(document.createElement("a"), { href, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } catch (e) {
    toast.error("Couldn't save the file", { description: (e as Error).message });
  }
}

/** Types `text` into the message box (e.g. an @mention). */
export function insertIntoComposer(text: string) {
  window.dispatchEvent(new CustomEvent("composer-insert", { detail: text }));
}

export function markGuildRead(guildId: string) {
  const { channels, markRead } = useApp.getState();
  for (const c of Object.values(channels)) if (c.guildId === guildId && c.kind === "text") markRead(c.id);
}

async function attempt(fn: () => Promise<unknown>) {
  try {
    await fn();
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

/** Leaves (or, for its owner, deletes) a server after confirming. */
export async function leaveGuild(guildId: string): Promise<boolean> {
  const s = useApp.getState();
  const guild = s.guilds[guildId];
  const owner = guild?.ownerId === s.me?.id;
  if (!guild || !confirm(`${owner ? "Delete" : "Leave"} "${guild.name}"?${owner ? " This can't be undone." : ""}`)) return false;
  const ok = await attempt(() => api("DELETE", owner ? `/guilds/${guildId}` : `/guilds/${guildId}/members/@me`));
  if (ok) useApp.getState().apply({ t: "GUILD_DELETE", d: { id: guildId } });
  return ok;
}

export async function deleteChannel(channelId: string) {
  const c = useApp.getState().channels[channelId];
  if (!c || !confirm(`Delete ${c.kind === "category" ? "category" : "channel"} "${c.name}"? This can't be undone.`)) return;
  if (await attempt(() => api("DELETE", `/channels/${channelId}`))) useApp.getState().apply({ t: "CHANNEL_DELETE", d: { id: channelId, guildId: c.guildId } });
}

export async function kick(guildId: string, userId: string) {
  const s = useApp.getState();
  const m = s.members[guildId]?.[userId];
  const name = m?.nick ?? m?.user.displayName ?? "this member";
  if (!confirm(`Kick ${name} from ${s.guilds[guildId]?.name ?? "the server"}? They can rejoin with an invite.`)) return;
  if (await attempt(() => api("DELETE", `/guilds/${guildId}/members/${userId}`))) toast.success(`Kicked ${name}`);
}
