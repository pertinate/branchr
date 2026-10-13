import { type Page, expect, test } from "@playwright/test";

import { createServer, register } from "./helpers";

/** Server names in the rail, top to bottom (open folders included). */
function railOrder(page: Page) {
  return page.locator('nav[aria-label="Communities"] [data-rail-item] a[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
}

test("rail: newest on top, drag to reorder, folders, My Guilds", async ({ browser }) => {
  const page = await register(browser, "rail");
  const run = Date.now().toString(36);
  const [a, b, c] = ["Alpha", "Beta", "Gamma"].map((n) => `${n} ${run}`);
  for (const name of [a, b, c]) await createServer(page, name);
  await expect.poll(() => railOrder(page)).toEqual([c, b, a]);

  // Drag Alpha to the top; the order survives a reload.
  const slot = (name: string) => page.locator('nav[aria-label="Communities"] [data-rail-item]').filter({ has: page.getByRole("link", { name, exact: true }) });
  await slot(a).dragTo(slot(c), { targetPosition: { x: 36, y: 2 } });
  await expect.poll(() => railOrder(page)).toEqual([a, c, b]);
  await page.reload();
  await expect.poll(() => railOrder(page)).toEqual([a, c, b]);

  // Beta onto Gamma makes a folder, closed: its servers hide behind it.
  await slot(b).dragTo(slot(c));
  const folder = page.getByTestId("rail-folder");
  await expect(folder).toHaveCount(1);
  await expect.poll(() => railOrder(page)).toEqual([a]);
  await folder.click();
  await expect.poll(() => railOrder(page)).toEqual([a, c, b]);

  // Name it.
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Folder Settings" }).click();
  await page.getByLabel("Folder name").fill("Games");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Games" })).toBeVisible();

  // Take Beta back out; it lands after the folder.
  await page.getByRole("link", { name: b, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Folder" }).click();
  await expect.poll(() => railOrder(page)).toEqual([a, c, b]);
  await expect(page.locator('[data-rail-item^="folder:"]')).toHaveCount(1);

  // A new server goes on top, outside folders.
  const d = `Delta ${run}`;
  await createServer(page, d);
  await expect.poll(() => railOrder(page)).toEqual([d, a, c, b]);

  // My Guilds: every server, by host.
  await page.getByRole("link", { name: "Explore" }).click();
  const section = page.getByTestId("host-section");
  await expect(section).toHaveCount(1);
  await expect(section.getByTestId("guild-card")).toHaveCount(4);
  await section.getByTestId("guild-card").filter({ hasText: b }).click();
  await expect(page.getByPlaceholder("Message #general")).toBeVisible();
});
