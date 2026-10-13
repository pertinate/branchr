import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

const menu = (p: Page) => p.getByRole("menu");

test("search and pins: find messages by words, pin one, see it in Pinned Messages", async ({ browser }) => {
  const run = Date.now().toString(36);
  const alice = await register(browser, "srch_a");
  const code = await createServer(alice, "Library");
  const bob = await register(browser, "srch_b");
  await joinServer(bob, code);

  const box = alice.getByPlaceholder("Message #general");
  for (const text of [`alpha${run} bravo`, `charlie delta`, `Alpha${run} echo`]) {
    await box.fill(text);
    await box.press("Enter");
    await expect(alice.getByText(text, { exact: true })).toBeVisible();
  }

  // Search (case-insensitive, word prefixes) from Bob's side.
  await bob.getByLabel("Search messages").fill(`alpha${run.slice(0, 4)}`);
  await bob.getByLabel("Search messages").press("Enter");
  const panel = bob.getByTestId("search-panel");
  await expect(panel.getByTestId("found-message")).toHaveCount(2);
  await expect(panel).toContainText("echo");
  await expect(panel).not.toContainText("charlie");
  await bob.getByLabel("Close search").click();
  await expect(panel).toHaveCount(0);

  // Filters: from:, has:, in:, and a name that isn't there.
  const search = async (q: string) => {
    await bob.getByLabel("Search messages").fill(q);
    await bob.getByLabel("Search messages").press("Enter");
  };
  await bob.getByPlaceholder("Message #general").fill(`alpha${run} see https://example.invalid/page`);
  await bob.getByPlaceholder("Message #general").press("Enter");
  await search(`alpha${run}`);
  await expect(panel.getByTestId("found-message")).toHaveCount(3);
  await search(`alpha${run} from:srch_a`);
  await expect(panel.getByTestId("found-message")).toHaveCount(2);
  await search("has:link");
  await expect(panel.getByTestId("found-message")).toHaveCount(1);
  await expect(panel).toContainText("example.invalid");
  await search(`charlie in:general`);
  await expect(panel.getByTestId("found-message")).toHaveCount(1);
  await search("from:nobody_here");
  await expect(panel).toContainText("No one here called nobody_here.");
  await bob.getByLabel("Close search").click();

  // Only people who manage messages can pin.
  await bob.getByText("charlie delta").click({ button: "right" });
  await expect(menu(bob).getByRole("menuitem", { name: "Copy Text" })).toBeVisible();
  await expect(menu(bob).getByRole("menuitem", { name: "Pin Message" })).toHaveCount(0);
  await bob.keyboard.press("Escape");

  await alice.getByText("charlie delta").click({ button: "right" });
  await menu(alice).getByRole("menuitem", { name: "Pin Message" }).click();
  await bob.getByLabel("Pinned Messages").click();
  await expect(bob.getByTestId("pins").getByTestId("found-message")).toHaveCount(1);
  await expect(bob.getByTestId("pins")).toContainText("charlie delta");
  await bob.keyboard.press("Escape");

  // Unpinned: the list is empty again.
  await alice.getByText("charlie delta").click({ button: "right" });
  await menu(alice).getByRole("menuitem", { name: "Unpin Message" }).click();
  await bob.getByLabel("Pinned Messages").click();
  await expect(bob.getByText("This channel doesn't have any pinned messages yet.")).toBeVisible();
});
