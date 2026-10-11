import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register, session } from "./helpers";

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const menu = (p: Page) => p.getByRole("menu");
const item = (p: Page, name: string | RegExp) => menu(p).getByRole("menuitem", { name, exact: typeof name === "string" });
const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText());

test("context menus: messages, people, channels, servers", async ({ browser }) => {
  const alice = await register(browser, "ctx_a");
  await alice.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const code = await createServer(alice, "Menus");
  const bob = await register(browser, "ctx_b");
  await joinServer(bob, code);
  alice.on("dialog", (d) => void d.accept());

  const box = alice.getByPlaceholder("Message #general");
  await box.fill("hello from alice https://example.com/page");
  await box.press("Enter");

  // Quick reaction from the menu.
  await alice.getByText("hello from alice").click({ button: "right" });
  await menu(alice).getByRole("menuitem", { name: "React 👍" }).click();
  await expect(bob.getByRole("button", { name: /👍\s*1/ })).toBeVisible();

  // Add Reaction opens the picker by the message, and it stays open.
  await alice.getByText("hello from alice").click({ button: "right" });
  await item(alice, "Add Reaction").click();
  const picker = alice.locator("[data-slot=popover-content]");
  await expect(picker).toBeVisible();
  await alice.waitForTimeout(300);
  await expect(picker).toBeVisible();
  const at = await picker.boundingBox();
  expect(at!.x).toBeGreaterThan(200);
  expect(at!.y).toBeGreaterThan(50);
  await alice.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  // Copy Text copies what you see.
  await alice.getByText("hello from alice").click({ button: "right" });
  await item(alice, "Copy Text").click();
  expect(await clipboard(alice)).toBe("hello from alice https://example.com/page");

  // On a link, the menu leads with link items.
  await alice.getByRole("link", { name: "https://example.com/page" }).click({ button: "right" });
  await expect(item(alice, "Copy Link")).toBeVisible();
  await item(alice, "Copy Link").click();
  expect(await clipboard(alice)).toBe("https://example.com/page");

  // Reply and Edit open the same UI as the hover buttons.
  await alice.getByText("hello from alice").click({ button: "right" });
  await item(alice, "Reply").click();
  await expect(alice.getByText(/Replying to/)).toBeVisible();
  await alice.keyboard.press("Escape");
  await alice.getByText("hello from alice").click({ button: "right" });
  await item(alice, "Edit Message").click();
  const edit = alice.locator("textarea:not([placeholder])");
  await edit.fill("edited via menu");
  await edit.press("Enter");
  await expect(bob.getByText("edited via menu")).toBeVisible();

  // Bob can't edit or delete Alice's message.
  await bob.getByText("edited via menu").click({ button: "right" });
  await expect(item(bob, "Reply")).toBeVisible();
  await expect(item(bob, "Edit Message")).toHaveCount(0);
  await expect(item(bob, "Delete Message")).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // People: Mention types @username into the message box.
  const bobName = (await session(bob)).user.username;
  await alice.locator("aside").last().getByText("ctx_b").click({ button: "right" });
  await item(alice, "Mention").click();
  await expect(box).toHaveValue(`@${bobName} `);
  await box.fill("");

  // Your own nickname, from the server icon.
  await alice.getByRole("link", { name: "Menus" }).click({ button: "right" });
  await item(alice, "Change Nickname").click();
  await alice.getByRole("textbox", { name: "Nickname" }).fill("Captain A");
  await alice.getByRole("button", { name: "Save" }).click();
  await expect(bob.locator("aside").last().getByText("Captain A")).toBeVisible();

  // Invite People from the server icon.
  await alice.getByRole("link", { name: "Menus" }).click({ button: "right" });
  await item(alice, "Invite People").click();
  await expect(alice.getByLabel("Invite code")).not.toHaveValue("");
  await alice.keyboard.press("Escape");

  // Channels: rename, then delete, from the channel list.
  await alice.getByRole("link", { name: /^general\b/ }).click({ button: "right" });
  await item(alice, "Edit Channel").click();
  await alice.getByLabel("Name").fill("lobby");
  await alice.getByLabel("Topic").fill("say hi");
  await alice.getByRole("button", { name: "Save" }).click();
  await expect(bob.getByRole("link", { name: /^lobby\b/ })).toBeVisible();
  await expect(bob.getByText("say hi")).toBeVisible();
  // Bob (not the owner) has no edit/delete.
  await bob.getByRole("link", { name: /^lobby\b/ }).click({ button: "right" });
  await expect(item(bob, "Mark As Read")).toBeVisible();
  await expect(item(bob, "Edit Channel")).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // Copy ID only with Developer Mode.
  await alice.locator("aside").last().getByText("ctx_b").click({ button: "right" });
  await expect(item(alice, "Copy User ID")).toHaveCount(0);
  await alice.keyboard.press("Escape");
  await alice.getByRole("button", { name: "User Settings" }).click();
  await alice.getByRole("tab", { name: "Advanced" }).click();
  await alice.getByLabel("Developer Mode").click();
  await alice.keyboard.press("Escape");
  await alice.locator("aside").last().getByText("ctx_b").click({ button: "right" });
  await item(alice, "Copy User ID").click();
  expect(await clipboard(alice)).toMatch(/^\d+$/);

  // Kick (owner only), then Bob is gone from the member list.
  await alice.locator("aside").last().getByText("ctx_b").click({ button: "right" });
  await item(alice, /^Kick /).click();
  await expect(alice.locator("aside").last().getByText("ctx_b")).toHaveCount(0);

  // Delete a message from the menu.
  await alice.getByText("edited via menu").click({ button: "right" });
  await item(alice, "Delete Message").click();
  await expect(alice.getByText("edited via menu")).toHaveCount(0);
});

test("context menus: images copy, and the composer's uploads", async ({ browser }) => {
  const alice = await register(browser, "ctx_img");
  await alice.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await createServer(alice, "Pictures");
  await alice.locator('input[type="file"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
  await expect(alice.locator('[data-upload="done"]')).toHaveCount(1);

  // Uploads waiting to send can be removed by right-click.
  await alice.locator('[data-upload="done"]').click({ button: "right" });
  await item(alice, "Remove Attachment").click();
  await expect(alice.locator("[data-upload]")).toHaveCount(0);

  await alice.locator('input[type="file"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG });
  await expect(alice.locator('[data-upload="done"]')).toHaveCount(1);
  await alice.getByPlaceholder("Message #general").press("Enter");
  const img = alice.locator('img[alt="pixel.png"]');
  await img.click({ button: "right" });
  await expect(item(alice, "Save Image")).toBeVisible();
  await item(alice, "Copy Image").click();
  await expect(alice.getByText("Image copied")).toBeVisible();
  const types = await alice.evaluate(async () => (await navigator.clipboard.read())[0]?.types ?? []);
  expect(types).toContain("image/png");
});
