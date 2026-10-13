import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

test("muting a channel hides its unread marker; community mute and notification level stick", async ({ browser }) => {
  const alice = await register(browser, "mute_a");
  const code = await createServer(alice, "Hush");
  const list = alice.getByTestId("channel-list");
  await list.click({ button: "right", position: { x: 100, y: 420 } });
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByPlaceholder("new-channel").fill("elsewhere");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await expect(alice.getByPlaceholder("Message #elsewhere")).toBeVisible();

  const bob = await register(browser, "mute_b");
  await joinServer(bob, code);
  await bob.getByRole("link", { name: "elsewhere", exact: true }).click();
  await expect(bob.getByPlaceholder("Message #elsewhere")).toBeVisible();
  const general = bob.getByRole("link", { name: "general", exact: true });

  // A message in #general while bob is elsewhere: unread.
  await alice.getByRole("link", { name: "general", exact: true }).click();
  await alice.getByPlaceholder("Message #general").fill("one");
  await alice.getByPlaceholder("Message #general").press("Enter");
  await expect(general).toHaveAttribute("data-unread", "true");

  // Muted: dimmed, and no marker, even for new messages.
  await general.click({ button: "right" });
  await bob.getByRole("menuitemcheckbox", { name: "Mute Channel" }).click();
  await expect(general).toHaveAttribute("data-muted", "true");
  await expect(general).not.toHaveAttribute("data-unread", "true");
  await alice.getByPlaceholder("Message #general").fill("two");
  await alice.getByPlaceholder("Message #general").press("Enter");
  await expect(bob.getByPlaceholder("Message #elsewhere")).toBeVisible();
  await expect(general).not.toHaveAttribute("data-unread", "true");

  // Unmuted, it's unread again.
  await general.click({ button: "right" });
  await bob.getByRole("menuitemcheckbox", { name: "Mute Channel", checked: true }).click();
  await expect(general).toHaveAttribute("data-unread", "true");

  // The community: muted with notifications off, from the header menu, and still so after a reload.
  await bob.getByRole("button", { name: "Hush" }).click();
  await bob.getByRole("menuitemcheckbox", { name: "Mute Community" }).click();
  await bob.getByRole("button", { name: "Hush" }).click();
  await bob.getByRole("menuitem", { name: "Notification Settings" }).hover();
  await bob.getByRole("menuitemradio", { name: "Nothing" }).click();
  await bob.reload();
  await bob.getByRole("button", { name: "Hush" }).click();
  await expect(bob.getByRole("menuitemcheckbox", { name: "Mute Community" })).toHaveAttribute("aria-checked", "true");
  await bob.getByRole("menuitem", { name: "Notification Settings" }).hover();
  await expect(bob.getByRole("menuitemradio", { name: "Nothing" })).toHaveAttribute("aria-checked", "true");
});
