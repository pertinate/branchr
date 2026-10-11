import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, "../../apps/desktop");

/** Which voice channel the gateway says we're in, sampled over time. */
async function voiceTimeline(win: import("@playwright/test").Page, ms: number) {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const status = await win.getByText(/Voice Connected|Reconnecting…|Connecting…/).first().innerText().catch(() => "none");
    const where = await win.locator("text=/ \\/ /").first().innerText().catch(() => "-");
    const s = `${status}@${where}`;
    if (seen[seen.length - 1] !== s) seen.push(s);
    await win.waitForTimeout(250);
  }
  return seen;
}

// The real desktop app (bundled UI), headless: join, switch channels, disconnect.
test("desktop: switching channels and disconnect are stable", async () => {
  // DESKTOP_EXE=path/to/app.AppImage tests a packaged build instead of the dev bundle.
  const packaged = process.env.DESKTOP_EXE;
  const executablePath = packaged ?? (require(require.resolve("electron", { paths: [desktopDir] })) as unknown as string);
  const app = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : [desktopDir]), "--ozone-platform=headless"],
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", DISCORD_CLONE_FAKE_MEDIA: "1", DISCORD_CLONE_PROFILE: mkdtempSync(path.join(tmpdir(), "dc-voice-")) },
  });
  const win = await app.firstWindow();
  const warnings: string[] = [];
  win.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
  await win.getByRole("button", { name: "Register" }).click();
  await win.getByLabel("Username").fill(`dv_${Date.now().toString(36)}`);
  await win.getByLabel("Password").fill("correct horse battery");
  await win.getByRole("button", { name: "Continue" }).click();
  await win.getByRole("button", { name: "Add a Server" }).click();
  await win.getByPlaceholder("Server name").fill("Voice Test");
  await win.getByRole("button", { name: "Create" }).click();

  await win.getByRole("link", { name: "General", exact: true }).click();
  await expect(win.getByText("Voice Connected")).toBeVisible();
  // The AI noise suppression model must load from file:// (no silent fallback).
  expect(warnings.filter((w) => w.includes("noise suppression"))).toEqual([]);

  await win.getByRole("link", { name: "Streaming", exact: true }).click();
  const afterSwitch = await voiceTimeline(win, 6000);
  console.log("after switch:", afterSwitch.join(" -> "));
  expect(afterSwitch[afterSwitch.length - 1]).toBe("Voice Connected@Streaming / Voice Test");
  // At most: connecting -> connected, no bouncing back to General.
  expect(afterSwitch.filter((s) => s.includes("General")).length).toBe(0);

  await win.getByRole("button", { name: "Disconnect" }).click();
  const afterLeave = await voiceTimeline(win, 6000);
  console.log("after disconnect:", afterLeave.join(" -> "));
  expect(afterLeave).toEqual(["none@-"]);
  await app.close();
});
