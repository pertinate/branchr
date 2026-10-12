import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

const menu = (p: Page) => p.getByRole("menu");
const item = (p: Page, name: string | RegExp) => menu(p).getByRole("menuitem", { name, exact: typeof name === "string" });
const memberList = (p: Page) => p.locator("aside").last();

test("roles: a moderator role can delete others' messages and is listed separately", async ({ browser }) => {
  const alice = await register(browser, "role_a");
  const code = await createServer(alice, "Ranks");
  const bob = await register(browser, "role_b");
  await joinServer(bob, code);
  bob.on("dialog", (d) => void d.accept());

  await alice.getByPlaceholder("Message #general").fill("owner says hi");
  await alice.keyboard.press("Enter");

  // Without a role, Bob can't delete Alice's message or open Server Settings.
  await bob.getByText("owner says hi").click({ button: "right" });
  await expect(item(bob, "Copy Text")).toBeVisible();
  await expect(item(bob, "Delete Message")).toHaveCount(0);
  await bob.keyboard.press("Escape");
  await bob.getByRole("button", { name: "Ranks" }).click();
  await expect(bob.getByRole("menuitem", { name: "Server Settings" })).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // Alice makes a Mods role that can manage messages, shown separately, in a colour.
  await alice.getByRole("button", { name: "Ranks" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByRole("tab", { name: "Roles" }).click();
  await alice.getByRole("button", { name: "Create Role" }).click();
  const editor = alice.getByTestId("role-editor");
  await editor.getByLabel("Role name").fill("Mods");
  await editor.getByRole("button", { name: "Color #e74c3c" }).click();
  await editor.getByLabel("Display separately").click();
  await editor.getByLabel("Manage Messages").click();
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(alice.getByText("Saved")).toBeVisible();
  await expect(alice.getByTestId("role-list").getByText("Mods")).toBeVisible();
  await alice.keyboard.press("Escape");

  // ...and gives it to Bob from the member list.
  await memberList(alice).getByText("role_b").click({ button: "right" });
  await menu(alice).getByRole("menuitem", { name: "Roles" }).click();
  await alice.getByRole("menuitemcheckbox", { name: "Mods" }).click();
  await expect(alice.getByRole("menuitemcheckbox", { name: "Mods" })).toHaveAttribute("aria-checked", "true");
  await alice.keyboard.press("Escape");
  await alice.keyboard.press("Escape");

  // Bob is listed under Mods, in its colour, for everyone.
  await expect(memberList(alice).getByText("Mods — 1")).toBeVisible();
  await expect(memberList(bob).getByText("Mods — 1")).toBeVisible();
  await expect(memberList(alice).getByText("role_b")).toHaveCSS("color", "rgb(231, 76, 60)");

  // Now he can delete Alice's message, and it goes for her too.
  await bob.getByText("owner says hi").click({ button: "right" });
  await item(bob, "Delete Message").click();
  await expect(alice.getByText("owner says hi")).toHaveCount(0);

  // He still can't kick the owner.
  await memberList(bob).getByText("role_a").click({ button: "right" });
  await expect(item(bob, "Copy Username")).toBeVisible();
  await expect(menu(bob).getByRole("menuitem", { name: /^Kick / })).toHaveCount(0);
});
