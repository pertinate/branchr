import { expect, test } from "@playwright/test";

import { createServer, register } from "./helpers";

test.skip(!process.env.TEST_DATABASE_URL, "Explore lives on branchr ID, which needs TEST_DATABASE_URL (Postgres)");

test("explore: list a server, find it by search and tag, join it, unlist it", async ({ browser }) => {
  const run = Date.now().toString(36);
  const name = `Lounge ${run}`;
  const alice = await register(browser, "exp_a");
  await createServer(alice, name);
  await alice.getByRole("button", { name }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByLabel("Description").fill("A quiet place to hang out");
  await alice.getByLabel("Show in Explore").click();
  await alice.getByLabel("Explore tags").fill("Chill, Testing");
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(alice.getByText("Saved")).toBeVisible();
  await alice.keyboard.press("Escape");

  // Bob finds it, by name and by tag, and joins from the card.
  const bob = await register(browser, "exp_b");
  await bob.getByRole("link", { name: "Explore" }).click();
  await bob.getByLabel("Explore servers").fill(run);
  const card = bob.getByTestId("explore-card").filter({ hasText: name });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("A quiet place to hang out");
  await expect(card).toContainText("chill");
  await expect(card).toContainText("1 members");
  await card.getByRole("button", { name: `Join ${name}` }).click();
  await expect(bob.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  await expect(bob.getByRole("link", { name })).toBeVisible();

  // Unlisted: it's gone from Explore.
  await alice.getByRole("button", { name }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByLabel("Show in Explore").click();
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(alice.getByText("Saved")).toBeVisible();
  await bob.getByRole("link", { name: "Explore" }).click();
  await bob.getByLabel("Explore servers").fill(run);
  await expect(async () => {
    // Another search in between, so coming back to this one fetches again.
    await bob.getByLabel("Explore servers").fill(`${run}x`);
    await bob.waitForTimeout(400);
    await bob.getByLabel("Explore servers").fill(run);
    await expect(bob.getByTestId("explore-card").filter({ hasText: name })).toHaveCount(0, { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
});
