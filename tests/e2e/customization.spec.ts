import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register, openUserSettings } from "./helpers";

/** A PNG drawn in the page. */
async function png(page: Page, w: number, h: number, color: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([w, h, color]) => {
      const c = document.createElement("canvas");
      [c.width, c.height] = [w as number, h as number];
      const g = c.getContext("2d")!;
      g.fillStyle = color as string;
      g.fillRect(0, 0, c.width, c.height);
      return c.toDataURL("image/png").split(",")[1];
    },
    [w, h, color],
  );
  return Buffer.from(b64, "base64");
}

test("customization: server icon, banner and description, and an avatar, seen by others", async ({ browser }) => {
  const alice = await register(browser, "cust_a");
  const code = await createServer(alice, "Pretty");
  const bob = await register(browser, "cust_b");
  await joinServer(bob, code);

  await alice.getByRole("button", { name: "Pretty" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByTestId("server-icon-file").setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: await png(alice, 600, 400, "#c0392b") });
  await alice.getByTestId("banner-file").setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: await png(alice, 1920, 1080, "#2980b9") });
  await alice.getByLabel("Description").fill("A server for pretty things");
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(alice.getByText("Saved")).toBeVisible();
  await alice.keyboard.press("Escape");

  // Bob sees the cropped icon in the rail, and the banner.
  const icon = bob.getByRole("link", { name: "Pretty" }).locator("img");
  await expect(icon).toHaveAttribute("src", /\/api\/files\/guild\/\d+\/icon-[0-9a-f]+\.webp$/);
  await expect.poll(() => icon.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(256);
  const banner = bob.getByTestId("guild-banner");
  await expect.poll(() => banner.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([960, 540]);

  // An avatar shows up next to Alice for Bob.
  await openUserSettings(alice);
  await alice.getByTestId("avatar-file").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: await png(alice, 300, 300, "#27ae60") });
  await expect(alice.getByRole("button", { name: "Remove" })).toBeVisible();
  await alice.keyboard.press("Escape");
  await expect(bob.locator("aside").last().locator('img[src*="/api/files/avatar/"]')).toHaveCount(1);

  // Removing the icon brings back the initials.
  await alice.getByRole("button", { name: "Pretty" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByRole("button", { name: "Remove" }).first().click();
  await expect(bob.getByRole("link", { name: "Pretty" }).locator("img")).toHaveCount(0);
});

test("invites: join messages, a one-use invite, and a vanity code", async ({ browser }) => {
  const alice = await register(browser, "inv_a");
  await createServer(alice, "Gated");

  // A one-use invite.
  await alice.getByRole("button", { name: "Gated" }).click();
  await alice.getByRole("menuitem", { name: "Invite People" }).click();
  await alice.getByLabel("Max uses").click();
  await alice.getByRole("option", { name: "1 use", exact: true }).click();
  const field = alice.getByLabel("Invite code");
  await expect(field).not.toHaveValue("");
  const once = await field.inputValue();
  await alice.keyboard.press("Escape");

  const bob = await register(browser, "inv_b");
  await joinServer(bob, once);
  // Alice sees Bob arrive in #general.
  await expect(alice.getByTestId("join-message").filter({ hasText: "inv_b" })).toBeVisible();

  // It's used up now.
  const carol = await register(browser, "inv_c");
  await carol.getByRole("button", { name: "Add a Server" }).click();
  await carol.getByRole("tab", { name: "Join" }).click();
  await carol.getByPlaceholder("Invite code or link").fill(once);
  await carol.getByRole("button", { name: "Join Server" }).click();
  await expect(carol.getByText(/expired or been used up/)).toBeVisible();
  await carol.keyboard.press("Escape");

  // A vanity code works for anyone.
  const vanity = `gated-${Date.now().toString(36)}`;
  await alice.getByRole("button", { name: "Gated" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByLabel("Vanity invite code").fill(vanity);
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(alice.getByText("Saved")).toBeVisible();
  await alice.keyboard.press("Escape");
  await joinServer(carol, vanity);
  await expect(alice.getByTestId("join-message").filter({ hasText: "inv_c" })).toBeVisible();
});
