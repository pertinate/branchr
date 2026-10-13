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

test("mutes and notification levels follow you to another device", async ({ browser }) => {
  const alice = await register(browser, "mute_dev");
  await createServer(alice, "Synced");
  const general = (p: typeof alice) => p.getByRole("link", { name: "general", exact: true });
  await general(alice).click({ button: "right" });
  await alice.getByRole("menuitemcheckbox", { name: "Mute Channel" }).click();
  await alice.getByRole("button", { name: "Synced" }).click();
  await alice.getByRole("menuitem", { name: "Notification Settings" }).hover();
  await alice.getByRole("menuitemradio", { name: "Nothing" }).click();
  await alice.waitForTimeout(800); // the save is debounced

  // Another device: the same login, nothing on it yet.
  const saved = await alice.evaluate(() => localStorage.getItem("sessions")!);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem("sessions")) localStorage.setItem("sessions", s);
  }, saved);
  const phone = await ctx.newPage();
  await phone.goto(alice.url());
  await expect(general(phone)).toHaveAttribute("data-muted", "true");
  await phone.getByRole("button", { name: "Synced" }).click();
  await phone.getByRole("menuitem", { name: "Notification Settings" }).hover();
  await expect(phone.getByRole("menuitemradio", { name: "Nothing" })).toHaveAttribute("aria-checked", "true");
  await phone.keyboard.press("Escape");
  await phone.keyboard.press("Escape");

  // Unmuting there shows on the first device right away.
  await general(phone).click({ button: "right" });
  await phone.getByRole("menuitemcheckbox", { name: "Mute Channel", checked: true }).click();
  await expect(general(alice)).not.toHaveAttribute("data-muted", "true");

  // And then they're quiet: no device answers a change by saving again.
  await phone.waitForTimeout(500);
  let saves = 0;
  for (const p of [alice, phone]) p.on("request", (r) => r.url().includes("/notify-settings") && saves++);
  await phone.waitForTimeout(1500);
  expect(saves).toBe(0);
});
