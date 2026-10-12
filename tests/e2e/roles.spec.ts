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
  await expect(bob.getByRole("menuitem", { name: "Leaflet Settings" })).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // Alice makes a Mods role that can manage messages, shown separately, in a colour.
  await alice.getByRole("button", { name: "Ranks" }).click();
  await alice.getByRole("menuitem", { name: "Leaflet Settings" }).click();
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
  // (The submenu may close as the pointer leaves it; the member list below confirms the role.)
  await alice.keyboard.press("Escape");
  await alice.keyboard.press("Escape");

  // Bob is listed under Mods, in its colour, for everyone.
  await expect(memberList(alice).getByText("Mods — 1")).toBeVisible();
  await expect(memberList(bob).getByText("Mods — 1")).toBeVisible();
  await expect(memberList(alice).getByText("role_b")).toHaveCSS("color", "rgb(231, 76, 60)");

  // His card lists the role; he's a password account, so no friend button.
  await memberList(alice).getByText("role_b").click();
  const card = alice.getByTestId("user-card");
  await expect(card.getByText("Mods")).toBeVisible();
  await expect(card.getByText(/password account/)).toBeVisible();
  await alice.keyboard.press("Escape");

  // Now he can delete Alice's message, and it goes for her too.
  await bob.getByText("owner says hi").click({ button: "right" });
  await item(bob, "Delete Message").click();
  await expect(alice.getByText("owner says hi")).toHaveCount(0);

  // He still can't kick the owner.
  await memberList(bob).getByText("role_a").click({ button: "right" });
  await expect(item(bob, "Copy Username")).toBeVisible();
  await expect(menu(bob).getByRole("menuitem", { name: /^Kick / })).toHaveCount(0);
  await bob.keyboard.press("Escape");

  // @Mods (picked from the suggestions) pings everyone with the role.
  const box = alice.getByPlaceholder("Message #general");
  await box.fill("@Mo");
  await alice.getByRole("button", { name: /@Mods/ }).click();
  await box.pressSequentially("meeting in 5");
  await box.press("Enter");
  const pinged = bob.locator("[data-pinged]").filter({ hasText: "meeting in 5" });
  await expect(pinged).toBeVisible();
  await expect(pinged.locator("[data-role-mention]")).toHaveText("@Mods");
  await expect(pinged.locator("[data-role-mention]")).toHaveCSS("color", "rgb(231, 76, 60)");
});

test("channel permissions: hide a channel from everyone, open it to one person, take their voice", async ({ browser }) => {
  const alice = await register(browser, "chp_a");
  const code = await createServer(alice, "Private");
  const bob = await register(browser, "chp_b");
  await joinServer(bob, code);
  const bobName = (await bob.evaluate(() => JSON.parse(localStorage.getItem("sessions") ?? "{}").state.sessions[0].user.username)) as string;

  await alice.getByRole("button", { name: "Private" }).click();
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByPlaceholder("new-channel").fill("staff");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  const staff = (p: Page) => p.getByRole("link", { name: /^staff\b/ });
  await expect(staff(bob)).toBeVisible();

  // @everyone can't see it: it disappears for Bob.
  const openPerms = async () => {
    await staff(alice).click({ button: "right" });
    await item(alice, "Edit Channel").click();
    await alice.getByRole("tab", { name: "Permissions" }).click();
  };
  await openPerms();
  await alice.getByRole("radio", { name: "View Channels: deny" }).click();
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(staff(bob)).toHaveCount(0);
  await alice.keyboard.press("Escape");
  await expect(staff(alice)).toBeVisible();

  await staff(alice).click();
  await alice.getByPlaceholder("Message #staff").fill("secret plans");
  await alice.keyboard.press("Enter");
  await expect(alice.getByText("secret plans")).toBeVisible();
  await expect(bob.getByText("secret plans")).toHaveCount(0);

  // Bob alone gets it back, and can read what was said.
  await openPerms();
  await alice.getByRole("combobox", { name: "Add a role or member" }).click();
  await alice.getByRole("option", { name: `@${bobName}` }).click();
  await expect(alice.getByTestId("overwrite-editor").getByText("chp_b")).toBeVisible();
  await alice.getByRole("radio", { name: "View Channels: allow" }).click();
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(staff(bob)).toBeVisible();
  await staff(bob).click();
  await expect(bob.getByText("secret plans")).toBeVisible();

  // ...but can't post there.
  await alice.getByRole("radio", { name: "Send Messages: deny" }).click();
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await expect(bob.getByTestId("composer-locked")).toBeVisible();
  await alice.keyboard.press("Escape");

  // No streaming in the General voice channel: the button is off for Bob there.
  await alice.getByRole("link", { name: "General", exact: true }).click({ button: "right" });
  await item(alice, "Edit Channel").click();
  await alice.getByRole("tab", { name: "Permissions" }).click();
  await alice.getByRole("radio", { name: "Stream: deny" }).click();
  await alice.getByRole("button", { name: "Save Changes" }).click();
  await alice.keyboard.press("Escape");
  await bob.getByRole("link", { name: "General", exact: true }).click();
  await expect(bob.getByText("Voice Connected")).toBeVisible();
  await expect(bob.getByRole("button", { name: "Stream" })).toBeDisabled();
  await expect(bob.getByRole("button", { name: "Video" })).toBeEnabled();
});
