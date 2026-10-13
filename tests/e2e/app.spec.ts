import { type Browser, type Page, expect, test } from "@playwright/test";

const run = Date.now().toString(36);

async function register(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[${name}] ${m.type()}: ${m.text()}`);
  });
  await page.goto("/#/login");
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(`${name}_${run}`);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  return page;
}

/** Counts presented video frames over `ms` using requestVideoFrameCallback. */
async function measureFps(page: Page, selector: string, ms = 3000) {
  return page.evaluate(
    ([sel, dur]) =>
      new Promise<{ fps: number; width: number; height: number }>((resolve) => {
        const v = document.querySelector(sel as string) as HTMLVideoElement;
        let frames = 0;
        const cb = () => {
          frames++;
          v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
        setTimeout(() => resolve({ fps: (frames * 1000) / (dur as number), width: v.videoWidth, height: v.videoHeight }), dur as number);
      }),
    [selector, ms] as const,
  );
}

test("chat, voice and screen streaming between two users", async ({ browser }) => {
  const alice = await register(browser, "alice");
  await expect(alice.getByText("No communities yet")).toBeVisible();

  // Alice creates a server.
  await alice.getByRole("button", { name: "Add a Community" }).click();
  await alice.getByPlaceholder("Community name").fill("E2E Server");
  await alice.getByRole("button", { name: "Create" }).click();
  await expect(alice.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();

  // Alice creates an invite.
  await alice.getByRole("button", { name: "E2E Server" }).click();
  await alice.getByRole("menuitem", { name: "Invite People" }).click();
  await expect(alice.locator("input[readonly]")).not.toHaveValue("");
  const code = await alice.locator("input[readonly]").inputValue();
  expect(code).toHaveLength(8);
  await alice.keyboard.press("Escape");

  // Bob joins with the invite.
  const bob = await register(browser, "bob");
  await bob.getByRole("button", { name: "Add a Community" }).click();
  await bob.getByRole("tab", { name: "Join" }).click();
  // An invite from a host we're not on offers to connect to it (here: cancel).
  await bob.getByPlaceholder("Invite code or link").fill(`http://other-server.example:8740/#/invite/${code}`);
  await bob.getByRole("button", { name: "Join Community" }).click();
  await expect(bob.getByRole("heading", { name: "Connect another hub" })).toBeVisible();
  await expect(bob.getByLabel("Hub", { exact: true })).toHaveValue("http://other-server.example:8740");
  await bob.getByRole("button", { name: "Cancel" }).click();
  await bob.getByRole("button", { name: "Add a Community" }).click();
  await bob.getByRole("tab", { name: "Join" }).click();
  await bob.getByPlaceholder("Invite code or link").fill(code);
  await bob.getByRole("button", { name: "Join Community" }).click();
  await expect(bob.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();

  // Realtime chat both ways.
  await alice.getByPlaceholder("Message #general").fill("hello from alice **bold**");
  await alice.keyboard.press("Enter");
  await expect(bob.getByText("hello from alice")).toBeVisible();
  await expect(bob.locator("strong", { hasText: "bold" })).toBeVisible();
  await bob.getByPlaceholder("Message #general").fill("hi alice");
  await bob.keyboard.press("Enter");
  await expect(alice.getByText("hi alice")).toBeVisible();

  // Both join voice.
  await alice.getByRole("link", { name: "General", exact: true }).click();
  await expect(alice.getByText("Voice Connected")).toBeVisible();
  await bob.getByRole("link", { name: "General", exact: true }).click();
  await expect(bob.getByText("Voice Connected")).toBeVisible();

  // Alice goes live at 1080p60 with simulcast.
  await alice.getByRole("button", { name: "Stream" }).click();
  await alice.getByRole("button", { name: "1080p" }).click();
  await alice.getByRole("button", { name: "60", exact: true }).click();
  await alice.getByRole("button", { name: "Go Live" }).click();
  await expect(alice.getByText("YOUR STREAM")).toBeVisible();

  // Bob watches.
  await bob.getByRole("button", { name: "Watch Stream" }).click();
  const video = "video";
  await expect.poll(async () => bob.evaluate((s) => (document.querySelector(s) as HTMLVideoElement | null)?.videoWidth ?? 0, video), { timeout: 20_000 }).toBeGreaterThan(0);
  // Stats overlay is reachable and reports a codec.
  await bob.locator(video).hover();
  await bob.getByRole("button", { name: "Stream stats" }).click();
  const overlay = bob.locator(".font-mono.text-\\[11px\\]");
  await expect(overlay).toContainText("Codec:");

  // With plenty of bandwidth, auto allocation converges on the full quality layer.
  await expect(overlay).toContainText("Layer: h", { timeout: 20_000 });
  const high = await measureFps(bob, video);
  console.log("auto/high layer", high, "\n" + (await overlay.innerText()));
  expect(high.fps).toBeGreaterThan(10);

  // Forcing the low layer switches on the next keyframe.
  await bob.getByRole("button", { name: /Quality/ }).click();
  await bob.getByRole("menuitemradio", { name: "Low" }).click();
  await expect(overlay).toContainText("Layer: l");
  await expect.poll(async () => (await measureFps(bob, video, 1000)).width, { timeout: 20_000 }).toBeLessThan(high.width);
  console.log("low layer", await measureFps(bob, video, 1500));

  // Stopping the stream removes it for Bob.
  await alice.getByRole("button", { name: "Stop", exact: true }).first().click();
  await expect(bob.getByRole("button", { name: "Watch Stream" })).toHaveCount(0);

  // Disconnect really leaves (it used to auto-rejoin).
  await bob.getByRole("button", { name: "Disconnect" }).click();
  await bob.waitForTimeout(4000);
  await expect(bob.getByText(/Voice Connected|Reconnecting|Connecting…/)).toHaveCount(0);
  await expect(bob.getByRole("button", { name: "Join Voice" })).toBeVisible();
});
