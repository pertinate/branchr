import { expect, test } from "@playwright/test";

import { createServer, register } from "./helpers";

test("Ctrl+K jumps to a channel or community by name; Alt+arrows step through channels", async ({ browser }) => {
  const alice = await register(browser, "qs_a");
  await createServer(alice, "Switchboard");
  // A second channel to jump to.
  await alice.getByTestId("channel-list").click({ button: "right", position: { x: 100, y: 420 } });
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByPlaceholder("new-channel").fill("announcements");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await expect(alice.getByPlaceholder("Message #announcements")).toBeVisible();
  await alice.getByRole("link", { name: "general", exact: true }).click();
  await expect(alice.getByPlaceholder("Message #general")).toBeVisible();

  await alice.keyboard.press("Control+k");
  const box = alice.getByRole("textbox", { name: "Where would you like to go?" });
  await box.fill("annou");
  await expect(alice.getByRole("option").first()).toContainText("announcements");
  await box.press("Enter");
  await expect(alice.getByPlaceholder("Message #announcements")).toBeVisible();
  await expect(box).toHaveCount(0);

  // Communities too, and Escape closes it.
  await alice.keyboard.press("Control+k");
  await box.fill("switch");
  await expect(alice.getByRole("option", { name: /Switchboard/ })).toBeVisible();
  await box.press("Escape");
  await expect(box).toHaveCount(0);

  // Alt+↑ goes back up to #general; Alt+↓ down again.
  await alice.keyboard.press("Alt+ArrowUp");
  await expect(alice.getByPlaceholder("Message #general")).toBeVisible();
  await alice.keyboard.press("Alt+ArrowDown");
  await expect(alice.getByPlaceholder("Message #announcements")).toBeVisible();
});
