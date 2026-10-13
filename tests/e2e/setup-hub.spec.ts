import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

test.skip(!process.env.TEST_DATABASE_URL, "needs branchr ID (TEST_DATABASE_URL)");

const ROOT = path.resolve(import.meta.dirname, "../..");

test("set up a hub from the app: a code, one start, and it's yours through the gateway", async ({ browser }) => {
  const ctx = await browser.newContext();
  const run = Date.now().toString(36);
  await ctx.addCookies([{ name: "mock_discord_user", value: encodeURIComponent(JSON.stringify({ id: `6${Date.now()}`, username: `e2e_setup_${run}`, global_name: "Setter" })), domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto("/#/setup-hub");
  await page.getByRole("button", { name: "Sign in with Discord" }).click();
  // Back here after signing in.
  await expect(page.getByText("Signed in as")).toBeVisible();
  await page.getByLabel("Hub name").fill(`Den ${run}`);
  await page.getByRole("button", { name: "Get a setup code" }).click();
  const code = (await page.locator("code").filter({ hasText: /^BRS-/ }).first().innerText()).trim();
  expect(code).toMatch(/^BRS-[A-Z0-9-]{19}$/);
  await expect(page.getByText("Waiting for your Hub to start…")).toBeVisible();

  // What the page tells you to run, started here (relay-key-stack.sh's gateway and sfu).
  let hub: ChildProcess | undefined;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "setup-hub-"));
    hub = spawn(path.join(ROOT, "target/debug/api"), [], {
      env: {
        ...process.env,
        DATABASE_URL: `sqlite://${dir}/db.sqlite`,
        UPLOAD_DIR: `${dir}/up`,
        API_BIND: "127.0.0.1:18380",
        SFU_URLS: "ws://127.0.0.1:18290/ws",
        VOICE_SECRET: "e2e-key",
        BRANCHR_SETUP: code,
        BRANCHR_ID_URL: "http://localhost:18070",
        AUTH_MODE: "both",
        RELAY: "1",
        TRUST_PROXY: "1",
        INSTANCE_NAME: `Den ${run}`,
        BRANCHR_POLL_SECS: "1",
        CLAIM_FILE: `${dir}/claim.txt`,
      },
      stdio: "ignore",
    });
    await expect(page.getByText("Your Hub checked in with branchr: it's yours.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Reachable through branchr\.us/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Open your Hub" }).click();
    await expect(page.getByRole("heading", { name: "No communities yet" })).toBeVisible();
    await expect(page.getByText(`Den ${run}`)).toBeVisible();
  } finally {
    hub?.kill();
    await ctx.close();
  }
});
