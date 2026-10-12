import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { joinServer, joinVoice, register } from "./helpers";

// Real desktop app on the real GPU (needs a display): stream + camera soak test.
// Opt-in: SOAK_SECONDS=90 pnpm test desktop-stream
const soak = Number(process.env.SOAK_SECONDS ?? 0);
test.skip(!soak, "set SOAK_SECONDS to run");
test.setTimeout((soak + 120) * 1000);

const require = createRequire(import.meta.url);
const desktopDir = path.resolve(import.meta.dirname, "../../apps/desktop");

test("desktop streamer stays connected while streaming with camera", async ({ browser }) => {
  const executablePath = require(require.resolve("electron", { paths: [desktopDir] })) as unknown as string;
  const app = await electron.launch({
    executablePath,
    args: [desktopDir],
    env: { ...process.env, BRANCHR_FAKE_MEDIA: "1", BRANCHR_PROFILE: mkdtempSync(path.join(tmpdir(), "dc-profile-")) },
  });
  const s = await app.firstWindow();
  const logs: string[] = [];
  s.on("console", (m) => {
    if (m.type() !== "debug") logs.push(`${m.type()}: ${m.text()}`);
  });

  await s.getByRole("button", { name: "Register" }).click();

  // The bundled app suggests the dev host; tests run their own.

  await s.getByLabel("Server", { exact: true }).fill("http://localhost:18080");
  await s.getByLabel("Username").fill(`soak_${Date.now().toString(36)}`);
  await s.getByLabel("Password").fill("correct horse battery");
  await s.getByRole("button", { name: "Continue" }).click();
  await s.getByRole("button", { name: "Add a Server" }).click();
  await s.getByPlaceholder("Server name").fill("Soak");
  await s.getByRole("button", { name: "Create" }).click();
  await s.getByRole("button", { name: "Soak" }).click();
  await s.getByRole("menuitem", { name: "Invite People" }).click();
  await expect(s.locator("input[readonly]")).not.toHaveValue("");
  const code = await s.locator("input[readonly]").inputValue();
  await s.keyboard.press("Escape");
  await joinVoice(s);

  await s.getByRole("button", { name: "Video" }).click();
  await s.getByRole("button", { name: "Stream" }).click();
  await s.getByRole("button", { name: "1440p" }).click();
  await s.getByRole("button", { name: "60", exact: true }).click();
  await s.getByRole("button", { name: "Go Live" }).click();
  await expect(s.getByText("YOUR STREAM")).toBeVisible();

  const viewer = await register(browser, "soak_viewer");
  await joinServer(viewer, code);
  await joinVoice(viewer);
  await viewer.getByRole("button", { name: "Watch Stream" }).click();
  await expect.poll(() => viewer.evaluate(() => document.querySelector("video")?.videoWidth ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);

  // Encoder details from the streamer's own stats.
  await s.getByText("YOUR STREAM").hover();
  await s.getByRole("button", { name: "Encoder stats" }).click();

  const start = Date.now();
  let samples = 0;
  while (Date.now() - start < soak * 1000) {
    await s.waitForTimeout(Number(process.env.SOAK_INTERVAL ?? 5000));
    const status = await s.getByText(/Voice Connected|Reconnecting|Connecting/).first().innerText();
    const overlay = await s.locator(".font-mono.text-\\[11px\\]").first().innerText().catch(() => "");
    const viewerFrames = await viewer.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const v = document.querySelector("video");
          if (!v) return resolve(0);
          let n = 0;
          const cb = () => {
            n++;
            v.requestVideoFrameCallback(cb);
          };
          v.requestVideoFrameCallback(cb);
          setTimeout(() => resolve(n), 1000);
        }),
    );
    const vstats = await viewer.evaluate(async () => {
      const out: string[] = [];
      for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
        if (pc.connectionState === "closed") continue;
        (await pc.getStats()).forEach((r: any) => {
          if (r.type === "inbound-rtp" && r.kind === "video")
            out.push(`mid${r.mid} ${r.frameWidth ?? 0}x${r.frameHeight ?? 0} recv=${r.framesReceived} dec=${r.framesDecoded} kf=${r.keyFramesDecoded} pli=${r.pliCount} nack=${r.nackCount} lost=${r.packetsLost} bytes=${r.bytesReceived}`);
        });
      }
      return out.join(" | ");
    });
    console.log(`  viewer: ${vstats}`);
    if (samples++ % 3 === 0) console.log(`t=${Math.round((Date.now() - start) / 1000)}s ${status} | viewer ${viewerFrames} fps | ${overlay.replace(/\n/g, " · ")}`);
    expect(status, logs.slice(-20).join("\n")).toBe("Voice Connected");
    expect(viewerFrames).toBeGreaterThan(5);
  }
  await app.close();
});
