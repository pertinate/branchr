import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, "../../apps/desktop");

// Requires `pnpm --filter desktop build:main` (and a web build) first.
test("desktop app boots, exposes the bridge and logs in", async () => {
  const executablePath = require(require.resolve("electron", { paths: [desktopDir] })) as unknown as string;
  const app = await electron.launch({
    executablePath,
    args: [desktopDir, "--ozone-platform=headless", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    // Fresh profile: never inherit a logged-in session.
    env: { ...process.env, DISCORD_CLONE_PROFILE: mkdtempSync(path.join(tmpdir(), "dc-boot-")) },
  });
  const win = await app.firstWindow();
  win.on("console", (m) => m.type() === "error" && console.log("[electron]", m.text()));
  await expect(win.getByRole("heading", { name: "Welcome back!" })).toBeVisible();

  const bridge = await win.evaluate(() => ({ platform: window.desktop?.platform, hasPicker: typeof window.desktop?.getSources }));
  expect(bridge).toEqual({ platform: "linux", hasPicker: "function" });
  const gpu = await win.evaluate(() => window.desktop!.gpuInfo());
  console.log("gpu features", JSON.stringify(gpu.features));

  const flags = await app.evaluate(({ app }) => app.commandLine.getSwitchValue("enable-features"));
  expect(flags).toContain("WebRTCPipeWireCapturer");

  // Log in against the running API from a file:// origin.
  await win.getByRole("button", { name: "Register" }).click();
  await win.getByLabel("Username").fill(`desk_${Date.now().toString(36)}`);
  await win.getByLabel("Password").fill("correct horse battery");
  await win.getByRole("button", { name: "Continue" }).click();
  await expect(win.getByText("No servers yet")).toBeVisible();
  await app.close();
});
