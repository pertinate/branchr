import { execSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import { createServer, joinServer, joinVoice, register } from "./helpers";

// Opt-in: LOAD_VIEWERS=10 SFU_SSH=root@host E2E_BASE_URL=... pnpm test load-sfu
const viewers = Number(process.env.LOAD_VIEWERS ?? 0);
const ssh = process.env.SFU_SSH;
test.skip(!viewers, "set LOAD_VIEWERS to run");
test.setTimeout(600_000);

function sfuCpu(): string {
  if (!ssh) return "n/a";
  return execSync(`ssh ${ssh} "docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}} {{.NetIO}}' discord-clone-sfu"`).toString().trim();
}

test("SFU fan-out load", async ({ browser }) => {
  const streamer = await register(browser, "load_streamer");
  const code = await createServer(streamer, "SFU Load");
  await joinVoice(streamer);
  await streamer.getByRole("button", { name: "Stream" }).click();
  await streamer.getByRole("button", { name: "1080p" }).click();
  await streamer.getByRole("button", { name: "60", exact: true }).click();
  await streamer.getByRole("button", { name: "Go Live" }).click();
  await expect(streamer.getByText("YOUR STREAM")).toBeVisible();
  await streamer.waitForTimeout(3000);
  console.log(`0 viewers: sfu ${sfuCpu()}`);

  const pages = [];
  for (let i = 0; i < viewers; i++) {
    const p = await register(browser, `load_v${i}`);
    await joinServer(p, code);
    await joinVoice(p);
    await p.getByRole("button", { name: "Watch Stream" }).click();
    pages.push(p);
  }
  for (const p of pages) {
    await expect.poll(() => p.evaluate(() => document.querySelector("video")?.videoWidth ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  }
  await streamer.waitForTimeout(5000);
  for (let i = 0; i < 3; i++) {
    console.log(`${viewers} viewers: sfu ${sfuCpu()}`);
    await streamer.waitForTimeout(2000);
  }
  // Every viewer is still receiving frames.
  for (const p of pages) {
    const frames = await p.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const v = document.querySelector("video")!;
          let n = 0;
          const cb = () => {
            n++;
            v.requestVideoFrameCallback(cb);
          };
          v.requestVideoFrameCallback(cb);
          setTimeout(() => resolve(n), 2000);
        }),
    );
    expect(frames).toBeGreaterThan(10);
  }
});
