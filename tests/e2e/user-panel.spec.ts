import { expect, test } from "@playwright/test";

import { createServer, joinVoice, register } from "./helpers";

test("account dock collapses, overlays on hover, and expands during calls", async ({ browser }) => {
  const page = await register(browser, "dock");
  await createServer(page, "Dock");
  const account = page.getByRole("button", { name: "Your account", exact: true });
  const panel = page.getByTestId("user-panel");
  const composer = page.getByPlaceholder("Message #general");
  const before = await composer.boundingBox();

  await expect(panel).toHaveAttribute("data-expanded", "false");
  const anchor = await account.boundingBox();
  expect(anchor!.x).toBeLessThan(72);
  expect(anchor!.y).toBeGreaterThan(800);

  await account.hover();
  await expect(panel).toHaveAttribute("data-expanded", "true");
  await expect(page.getByRole("button", { name: "User Settings" })).toBeVisible();
  await page.getByRole("button", { name: "User Settings" }).hover();
  await expect(panel).toHaveAttribute("data-expanded", "true");
  expect(await composer.boundingBox()).toEqual(before);
  await composer.hover();
  await expect(panel).toHaveAttribute("data-expanded", "false");

  await account.click();
  await composer.hover();
  await expect(panel).toHaveAttribute("data-expanded", "true");
  await composer.click();
  await expect(panel).toHaveAttribute("data-expanded", "false");

  await account.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "User Settings" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  await expect(panel).toHaveAttribute("data-expanded", "false");

  await joinVoice(page);
  await page.mouse.move(700, 200);
  await expect(panel).toHaveAttribute("data-expanded", "true");
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.mouse.move(700, 200);
  await expect(panel).toHaveAttribute("data-expanded", "false");
  await page.context().close();
});
