import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, expect, test } from "@playwright/test";

/** 12 s of keyboard-like clicks (decaying noise bursts, ~7/s), 48 kHz mono 16-bit WAV. */
function clicksWav(): string {
  const rate = 48000;
  const n = rate * 12;
  const data = Buffer.alloc(44 + n * 2);
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = (t * 6.7 + 0.4 * Math.sin(t * 2.3)) % 1;
    data.writeInt16LE(Math.round(rand() * 0.9 * Math.exp(-phase * 90) * 32767), 44 + i * 2);
  }
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "noise-")), "clicks.wav");
  writeFileSync(file, data);
  return file;
}

// Imports the client's mic module straight from the Vite dev server.
test.skip(!!process.env.E2E_BASE_URL, "needs the local Vite dev server");

test("noise suppression: AI mode removes keyboard clicks", async ({ baseURL }) => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${clicksWav()}`],
  });
  const page = await browser.newPage();
  await page.goto(baseURL!);
  const measure = (mode: string) =>
    page.evaluate(async (mode) => {
      const { openMic } = await import("/src/voice/mic.ts");
      const mic = await openMic({ deviceId: null, noiseSuppression: mode as never, echoCancellation: false, autoGainControl: false });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(new MediaStream([mic.track])).connect(an);
      const buf = new Float32Array(2048);
      await new Promise((r) => setTimeout(r, 1000));
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 75; i++) {
        an.getFloatTimeDomainData(buf);
        for (const v of buf) sum += v * v;
        n += buf.length;
        await new Promise((r) => setTimeout(r, 40));
      }
      mic.stop();
      await ctx.close();
      return { db: 10 * Math.log10(sum / n + 1e-12), mode: mic.mode };
    }, mode);

  const off = await measure("off");
  const ai = await measure("gtcrn");
  console.log(`clicks: off ${off.db.toFixed(1)} dB, AI ${ai.db.toFixed(1)} dB`);
  expect(ai.mode).toBe("gtcrn"); // the model loaded; no silent fallback
  expect(off.db).toBeGreaterThan(-40);
  expect(off.db - ai.db).toBeGreaterThan(25);
  await browser.close();
});
