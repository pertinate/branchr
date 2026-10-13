import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

test("Mark Unread: the channel stays unread after you leave it, and after a reload", async ({ browser }) => {
  const alice = await register(browser, "mu_a");
  const code = await createServer(alice, "Later");
  await alice.getByTestId("channel-list").click({ button: "right", position: { x: 100, y: 420 } });
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByPlaceholder("new-channel").fill("elsewhere");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await alice.getByRole("link", { name: "general", exact: true }).click();

  const bob = await register(browser, "mu_b");
  await joinServer(bob, code);
  await expect(bob.getByPlaceholder("Message #general")).toBeVisible();
  for (const t of ["first thing", "second thing", "third thing"]) {
    await alice.getByPlaceholder("Message #general").fill(t);
    await alice.getByPlaceholder("Message #general").press("Enter");
    await expect(bob.getByText(t, { exact: true })).toBeVisible();
  }

  await bob.getByText("second thing", { exact: true }).click({ button: "right" });
  await bob.getByRole("menuitem", { name: "Mark Unread" }).click();
  // Still on it: scrolling around doesn't read it again.
  await bob.mouse.wheel(0, 500);
  await bob.getByRole("link", { name: "elsewhere", exact: true }).click();
  const general = bob.getByRole("link", { name: "general", exact: true });
  await expect(general).toHaveAttribute("data-unread", "true");
  await bob.reload();
  await expect(general).toHaveAttribute("data-unread", "true");

  // Going back reads it.
  await general.click();
  await expect(bob.getByText("third thing", { exact: true })).toBeVisible();
  await bob.getByRole("link", { name: "elsewhere", exact: true }).click();
  await expect(general).not.toHaveAttribute("data-unread", "true");
});
