import { expect, test } from "@playwright/test";

import { createServer, joinServer, openUserSettings, register, session } from "./helpers";

test("custom status and Do Not Disturb show to others and survive a reload", async ({ browser }) => {
  const alice = await register(browser, "status_a");
  const code = await createServer(alice, "Statuses");
  const bob = await register(browser, "status_b");
  await joinServer(bob, code);

  // Do Not Disturb and a custom status, from the account menu.
  const account = alice.getByRole("button", { name: "Your account", exact: true });
  await account.click({ button: "right" });
  await alice.getByRole("menuitem", { name: "Status", exact: true }).hover();
  await alice.getByRole("menuitemradio", { name: "Do Not Disturb" }).click();
  await account.click({ button: "right" });
  await alice.getByRole("menuitem", { name: "Set Custom Status" }).click();
  await alice.getByRole("textbox", { name: "Custom status" }).fill("  making dinner  ");
  await alice.getByRole("button", { name: "Save" }).click();

  const custom = bob.getByTestId("custom-status").filter({ hasText: "making dinner" });
  await expect(custom).toHaveText("making dinner");
  await expect(bob.locator('[data-status="dnd"]')).toHaveCount(1);

  // A reload reconnects: it stays as chosen, without passing through online.
  await alice.reload();
  await expect(alice.getByPlaceholder("Message #general")).toBeVisible();
  await expect(custom).toBeVisible();
  await expect(bob.locator('[data-status="dnd"]')).toHaveCount(1);

  // Cleared.
  await account.click({ button: "right" });
  await alice.getByRole("menuitem", { name: "Edit Custom Status" }).click();
  await alice.getByRole("button", { name: "Clear" }).click();
  await expect(custom).toHaveCount(0);
});

test("going idle after ten minutes away, and back on input", async ({ browser }) => {
  const alice = await register(browser, "away_a");
  const code = await createServer(alice, "Away");
  const bob = await register(browser, "away_b");
  await joinServer(bob, code);
  // Alice's clock is ours to move.
  await alice.clock.install();
  await alice.reload();
  await expect(alice.getByPlaceholder("Message #general")).toBeVisible();
  // Bob's panel, and both in the member list.
  await expect(bob.locator('[data-status="online"]')).toHaveCount(3);

  await alice.clock.fastForward("11:00");
  await expect(bob.locator('[data-status="idle"]')).toHaveCount(1);
  await expect(alice.getByRole("button", { name: "Your account", exact: true }).locator('[data-status="idle"]')).toBeVisible();

  await alice.mouse.move(200, 200);
  await alice.mouse.move(300, 300);
  await expect(bob.locator('[data-status="idle"]')).toHaveCount(0);
});

test("about me: set in settings, shown on the user card", async ({ browser }) => {
  const alice = await register(browser, "prof_a");
  const code = await createServer(alice, "Profiles");
  const bob = await register(browser, "prof_b");
  await joinServer(bob, code);

  await openUserSettings(alice);
  await alice.getByLabel("About me").fill("I paint\nand climb");
  await alice.getByRole("button", { name: "Save", exact: true }).click();
  await expect(alice.getByText("Profile updated")).toBeVisible();

  await bob.getByText("prof_a", { exact: true }).click();
  await expect(bob.getByTestId("bio")).toHaveText("I paint\nand climb");

  // Someone who shares no community with her can't read it.
  const carol = await register(browser, "prof_c");
  await expect(carol.getByRole("button", { name: "Your account", exact: true })).toBeVisible();
  const aliceId = (await session(alice)).user.id;
  const c = await session(carol);
  const status = await carol.evaluate(
    async ([url, token, id]) => (await fetch(`${url}/api/users/${id}/profile`, { headers: { authorization: `Bearer ${token}` } })).status,
    [c.url, c.token, aliceId] as const,
  );
  expect(status).toBe(404);
});
