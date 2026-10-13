import { expect, test } from "@playwright/test";

import { showHubField } from "./helpers";

test.skip(!process.env.TEST_DATABASE_URL, "needs branchr ID (TEST_DATABASE_URL)");

/** relay-key-stack.sh: the hub's own api (to learn its key) and the gateway visitors use. */
const HUB_API = "http://localhost:18280";
const GATEWAY = "http://localhost:18900";

test("a hub admitted by its branchr key: reached at /h/<key>, voice direct", async ({ browser }) => {
  // It registers with branchr ID, gets a pass, and the gateway lets it in under its key.
  await expect.poll(async () => (await (await fetch(`${HUB_API}/api/instance`)).json()).instanceId, { timeout: 30_000 }).toBeTruthy();
  const key: string = (await (await fetch(`${HUB_API}/api/instance`)).json()).instanceId;
  const hub = `${GATEWAY}/h/${key}`;
  await expect.poll(async () => (await fetch(`${hub}/api/health`)).status, { timeout: 30_000 }).toBe(200);
  // Unknown keys go nowhere.
  expect((await fetch(`${GATEWAY}/h/00000000-0000-0000-0000-000000000000/api/health`)).status).toBe(502);

  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    const pcs: RTCPeerConnection[] = ((window as any).__pcs = []);
    window.RTCPeerConnection = class extends Orig {
      constructor(c?: RTCConfiguration) {
        super(c);
        pcs.push(this);
      }
    } as typeof RTCPeerConnection;
  });
  const page = await ctx.newPage();
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Register" }).click();
  await showHubField(page);
  await page.getByLabel("Hub", { exact: true }).fill(hub);
  await page.getByLabel("Username").fill(`rk_${Date.now().toString(36)}`);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Add a Community" }).click();
  await page.getByPlaceholder("Community name").fill("Keyed");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  await page.getByPlaceholder("Message #general").fill("through the key");
  await page.getByPlaceholder("Message #general").press("Enter");
  await expect(page.getByText("through the key")).toBeVisible();

  // Voice signaling goes through the gateway; the media itself straight to the hub's sfu.
  await page.getByRole("link", { name: "General", exact: true }).click();
  await expect(page.getByText("Voice Connected")).toBeVisible();
  const port = await page.evaluate(async () => {
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      const stats = await pc.getStats();
      for (const s of stats.values() as any) {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") return stats.get(s.remoteCandidateId)?.port;
      }
    }
    return null;
  });
  expect([51500, 51501]).toContain(port);
  await ctx.close();
});
