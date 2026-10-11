import { expect, test } from "@playwright/test";

import { createServer, joinServer, joinVoice, outboundVideoKbps, register } from "./helpers";

// The SFU relays a stream: the streamer uploads each layer once no matter how many watch.
test("streamer upload does not grow with viewer count", async ({ browser }) => {
  const streamer = await register(browser, "streamer");
  const code = await createServer(streamer, "Relay Test");
  await joinVoice(streamer);
  await streamer.getByRole("button", { name: "Stream" }).click();
  await streamer.getByRole("button", { name: "Go Live" }).click();
  await expect(streamer.getByText("YOUR STREAM")).toBeVisible();

  const viewers = [];
  for (const name of ["v1", "v2", "v3", "v4"]) {
    const p = await register(browser, name);
    await joinServer(p, code);
    await joinVoice(p);
    viewers.push(p);
  }

  // Let encoder bitrates settle with nobody watching vs. everyone watching.
  await streamer.waitForTimeout(4000);
  const idle = await outboundVideoKbps(streamer);
  for (const v of viewers) await v.getByRole("button", { name: "Watch Stream" }).click();
  for (const v of viewers) {
    await expect.poll(() => v.evaluate(() => document.querySelector("video")?.videoWidth ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  }
  await streamer.waitForTimeout(3000);
  const watched = await outboundVideoKbps(streamer);
  console.log(`streamer upload: ${idle} kbps with 0 viewers, ${watched} kbps with ${viewers.length} viewers`);
  // A mesh would be ~4x; allow generous noise for encoder rate variation.
  expect(watched).toBeLessThan(idle * 1.6 + 300);
});
