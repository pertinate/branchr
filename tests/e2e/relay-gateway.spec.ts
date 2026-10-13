import { type Browser, expect, test } from "@playwright/test";

/** A hub with no public address of its own, reached through branchr-relay (relay-stack.sh). */
const BRANCH = "http://localhost:18800/h/relayed";

async function user(browser: Browser, name: string) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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
  await page.getByLabel("Hub", { exact: true }).fill(BRANCH);
  await page.getByLabel("Username").fill(`${name}_${Date.now().toString(36)}`);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  return page;
}

test("a hub behind the relay: chat over its WebSocket, voice over its UDP", async ({ browser }) => {
  const a = await user(browser, "ra");
  await a.getByRole("button", { name: "Add a Community" }).click();
  await a.getByPlaceholder("Community name").fill("Relayed");
  await a.getByRole("button", { name: "Create" }).click();
  await expect(a.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  await a.getByRole("button", { name: "Relayed" }).click();
  await a.getByRole("menuitem", { name: "Invite People" }).click();
  await expect(a.locator("input[readonly]")).not.toHaveValue("");
  const code = await a.locator("input[readonly]").inputValue();
  await a.keyboard.press("Escape");

  const b = await user(browser, "rb");
  await b.getByRole("button", { name: "Add a Community" }).click();
  await b.getByRole("tab", { name: "Join" }).click();
  await b.getByPlaceholder("Invite code or link").fill(code);
  await b.getByRole("button", { name: "Join Community" }).click();
  await expect(b.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();

  await a.getByPlaceholder("Message #general").fill("through the gateway");
  await a.getByPlaceholder("Message #general").press("Enter");
  await expect(b.getByText("through the gateway")).toBeVisible();

  for (const p of [a, b]) {
    await p.getByRole("link", { name: "General", exact: true }).click();
    await expect(p.getByText("Voice Connected")).toBeVisible();
  }
  // Audio arrives, and it came from the gateway's public ports, not the sfu's own.
  const inbound = () =>
    b.evaluate(async () => {
      let bytes = 0;
      for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
        (await pc.getStats()).forEach((s: any) => {
          if (s.type === "inbound-rtp" && s.kind === "audio") bytes += s.bytesReceived;
        });
      }
      return bytes;
    });
  await expect.poll(inbound, { timeout: 15_000 }).toBeGreaterThan(2000);
  const port = await b.evaluate(async () => {
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      const stats = await pc.getStats();
      for (const s of stats.values() as any) {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") return stats.get(s.remoteCandidateId)?.port;
      }
    }
    return null;
  });
  expect([51300, 51301]).toContain(port);
});
