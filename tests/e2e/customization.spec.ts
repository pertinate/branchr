import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

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
  await alice.getByRole("button", { name: "Your account" }).hover();
  await alice.getByRole("button", { name: "User Settings" }).click();
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
