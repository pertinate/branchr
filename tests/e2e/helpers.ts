import { type Browser, type Page, expect } from "@playwright/test";

const run = Date.now().toString(36);

export async function register(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // Collect peer connections so tests can read transport-level stats.
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    const pcs: RTCPeerConnection[] = ((window as any).__pcs = []);
    window.RTCPeerConnection = class extends Orig {
      constructor(cfg?: RTCConfiguration) {
        super(cfg);
        pcs.push(this);
      }
    } as typeof RTCPeerConnection;
  });
  // Emote images come from the providers' CDNs; serve them locally so tests stay offline.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await ctx.route(/^https:\/\/cdn\.(7tv\.app|frankerfacez\.com|betterttv\.net)\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: pixel }),
  );
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${name}] ${m.type()}: ${m.text()}`);
  });
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(`${name}_${run}`);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  return page;
}

export async function createServer(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Add a Community" }).click();
  await page.getByPlaceholder("Community name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  await page.getByRole("button", { name }).click();
  await page.getByRole("menuitem", { name: "Invite People" }).click();
  // The dialog creates the invite after it opens.
  await expect(page.locator("input[readonly]")).not.toHaveValue("");
  const code = await page.locator("input[readonly]").inputValue();
  await page.keyboard.press("Escape");
  return code;
}

export async function joinServer(page: Page, code: string) {
  await page.getByRole("button", { name: "Add a Community" }).click();
  await page.getByRole("tab", { name: "Join" }).click();
  await page.getByPlaceholder("Invite code or link").fill(code);
  await page.getByRole("button", { name: "Join Community" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
}

export async function joinVoice(page: Page, channel = "General") {
  await page.getByRole("link", { name: channel, exact: true }).click();
  await expect(page.getByText("Voice Connected")).toBeVisible();
}

/** Total outgoing video bitrate (all layers) over `ms`, in kbps. */
export async function outboundVideoKbps(page: Page, ms = 3000): Promise<number> {
  const total = () =>
    page.evaluate(async () => {
      let bytes = 0;
      for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
        if (pc.connectionState === "closed") continue;
        (await pc.getStats()).forEach((s: any) => {
          if (s.type === "outbound-rtp" && s.kind === "video") bytes += s.bytesSent + (s.retransmittedBytesSent ?? 0);
        });
      }
      return { bytes, t: performance.now() };
    });
  const a = await total();
  await page.waitForTimeout(ms);
  const b = await total();
  return Math.round(((b.bytes - a.bytes) * 8) / (b.t - a.t));
}

export interface StoredSession {
  id: string;
  url: string;
  token: string;
  user: { id: string; username: string; displayName: string };
}

/** The page's saved logins, one per instance, in rail order. */
export function sessions(page: Page): Promise<StoredSession[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sessions") ?? "{}").state?.sessions ?? []);
}

/** The first (or only) saved login. */
export async function session(page: Page): Promise<StoredSession> {
  return (await sessions(page))[0];
}

/** Forgets every saved login (as if logged out everywhere); reload to take effect. */
export function forgetSessions(page: Page) {
  return page.evaluate(() => localStorage.setItem("sessions", JSON.stringify({ state: { sessions: [] }, version: 0 })));
}

/**
 * Opens User Settings from the account dock. Clicking pins the dock open (hovering is racy
 * on slow machines); it retries until the dialog is up.
 */
export async function openUserSettings(page: Page) {
  const button = page.getByRole("button", { name: "User Settings" });
  await expect(async () => {
    if (!(await page.getByRole("dialog").isVisible())) {
      if (!(await button.isVisible())) await page.getByRole("button", { name: "Your account" }).click();
      await button.click({ timeout: 2000 });
    }
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}
