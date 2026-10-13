import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

/** Where `name` comes in the channel list's text (categories and channels, top to bottom). */
const at = (page: Page, name: string) => page.getByTestId("channel-list").evaluate((el, n) => (el.textContent ?? "").indexOf(n), name);
const row = (page: Page, name: string) => page.locator("[data-channel-row]").filter({ has: page.getByText(name, { exact: true }) }).first();

test("channel list: right-click to create, drag to reorder and move; send button", async ({ browser }) => {
  const alice = await register(browser, "chan_a");
  const code = await createServer(alice, "Layout");
  const bob = await register(browser, "chan_b");
  await joinServer(bob, code);

  // The send button sends.
  await alice.getByPlaceholder("Message #general").fill("sent with the button");
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await expect(bob.getByText("sent with the button")).toBeVisible();
  await expect(alice.getByPlaceholder("Message #general")).toHaveValue("");

  // Right-click the empty space: create a category, then a channel.
  const list = alice.getByTestId("channel-list");
  await list.click({ button: "right", position: { x: 100, y: 420 } });
  await alice.getByRole("menuitem", { name: "Create Category" }).click();
  await alice.getByPlaceholder("New Channel").fill("Extras");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await expect(alice.getByRole("button", { name: "Extras", exact: true })).toBeVisible();
  await list.click({ button: "right", position: { x: 100, y: 420 } });
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByPlaceholder("new-channel").fill("memes");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await expect(alice.getByPlaceholder("Message #memes")).toBeVisible();

  // Into a category, by dropping on its header.
  await row(alice, "memes").dragTo(row(alice, "Extras"));
  await expect.poll(async () => (await at(bob, "memes")) > (await at(bob, "Extras"))).toBe(true);
  // Above #general, so into Text Channels.
  await row(alice, "memes").dragTo(row(alice, "general"), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(async () => (await at(bob, "memes")) < (await at(bob, "general"))).toBe(true);
  await expect.poll(async () => (await at(bob, "memes")) > (await at(bob, "Text Channels"))).toBe(true);
  // Categories reorder too.
  await row(alice, "Voice Channels").dragTo(row(alice, "Text Channels"), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(async () => (await at(bob, "Voice Channels")) < (await at(bob, "Text Channels"))).toBe(true);
  // And it all stays that way.
  await bob.reload();
  await expect(bob.getByTestId("channel-list")).toBeVisible();
  expect(await at(bob, "Voice Channels")).toBeLessThan(await at(bob, "Text Channels"));
  expect(await at(bob, "memes")).toBeLessThan(await at(bob, "general"));
  // Members can't drag.
  await expect(bob.locator("[data-channel-row]")).toHaveCount(0);
});
