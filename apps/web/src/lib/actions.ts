/** Actions shared by menus, buttons and shortcuts. */
import { toast } from "sonner";

import type { Status } from "@app/protocol";

import { type Instance, instances } from "@/lib/instances";

export async function copy(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
}

async function blobOf(url: string): Promise<Blob> {
  // Our own attachments come through the API, not a redirect to a bucket without CORS rules.
  const own = /\/api\/attachments\//.test(url) && !url.includes("?");
  const r = await fetch(own ? `${url}?proxy=1` : url);
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

export function markGuildRead(inst: Instance, guildId: string) {
  const { channels, markRead } = inst.app.getState();
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
export async function leaveGuild(inst: Instance, guildId: string): Promise<boolean> {
  const s = inst.app.getState();
  const guild = s.guilds[guildId];
  const owner = guild?.ownerId === s.me?.id;
  if (!guild || !confirm(`${owner ? "Delete" : "Leave"} "${guild.name}"?${owner ? " This can't be undone." : ""}`)) return false;
  const ok = await attempt(() => inst.api("DELETE", owner ? `/guilds/${guildId}` : `/guilds/${guildId}/members/@me`));
  if (ok) inst.app.getState().apply({ t: "GUILD_DELETE", d: { id: guildId } });
  return ok;
}

export async function deleteChannel(inst: Instance, channelId: string) {
  const c = inst.app.getState().channels[channelId];
  if (!c || !confirm(`Delete ${c.kind === "category" ? "category" : "channel"} "${c.name}"? This can't be undone.`)) return;
  if (await attempt(() => inst.api("DELETE", `/channels/${channelId}`))) inst.app.getState().apply({ t: "CHANNEL_DELETE", d: { id: channelId, guildId: c.guildId } });
}

export async function kick(inst: Instance, guildId: string, userId: string) {
  const s = inst.app.getState();
  const m = s.members[guildId]?.[userId];
  const name = m?.nick ?? m?.user.displayName ?? "this member";
  if (!confirm(`Kick ${name} from ${s.guilds[guildId]?.name ?? "the server"}? They can rejoin with an invite.`)) return;
  if (await attempt(() => inst.api("DELETE", `/guilds/${guildId}/members/${userId}`))) toast.success(`Kicked ${name}`);
}

/** Your status is the same everywhere: set it on every instance. */
export function setStatus(status: Status) {
  for (const i of instances()) i.gateway.send({ op: "set_status", d: { status } });
}
