import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

const memberList = (p: Page) => p.locator("aside").last();

test("bans: ban with recent messages deleted, can't rejoin, unban, all in the audit log", async ({ browser }) => {
  const alice = await register(browser, "ban_a");
  const code = await createServer(alice, "Strict");
  const bob = await register(browser, "ban_b");
  await joinServer(bob, code);

  await bob.getByPlaceholder("Message #general").fill("spam spam spam");
  await bob.keyboard.press("Enter");
  await expect(alice.getByText("spam spam spam")).toBeVisible();

  // Ban from the member list, deleting the last hour of messages.
  await memberList(alice).getByText("ban_b").click({ button: "right" });
  await alice.getByRole("menuitem", { name: /^Ban / }).click();
  await alice.getByLabel("Delete message history").click();
  await alice.getByRole("option", { name: "Previous hour" }).click();
  await alice.getByLabel("Reason").fill("spamming");
  await alice.getByRole("button", { name: "Ban", exact: true }).click();
  await expect(alice.getByText("spam spam spam")).toHaveCount(0);
  await expect(memberList(alice).getByText("ban_b")).toHaveCount(0);
  await expect(bob.getByRole("link", { name: "Strict" })).toHaveCount(0);

  // The invite no longer works for him.
  await bob.getByRole("button", { name: "Add a Server" }).click();
  await bob.getByRole("tab", { name: "Join" }).click();
  await bob.getByPlaceholder("Invite code or link").fill(code);
  await bob.getByRole("button", { name: "Join Server" }).click();
  await expect(bob.getByText("you're banned from this server")).toBeVisible();
  await bob.keyboard.press("Escape");

  // Listed under Bans with the reason; unbanning lets him back.
  await alice.getByRole("button", { name: "Strict" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByRole("tab", { name: "Bans" }).click();
  const banned = alice.getByTestId("ban-list");
  await expect(banned.getByText('"spamming"', { exact: false })).toBeVisible();
  await banned.getByRole("button", { name: "Unban" }).click();
  await expect(banned.getByText("Nobody is banned.")).toBeVisible();

  // The audit log has both, newest first.
  await alice.getByRole("tab", { name: "Audit Log" }).click();
  const entries = alice.getByTestId("audit-entry");
  await expect(entries.first()).toContainText("unbanned");
  await expect(entries.nth(1)).toContainText("banned");
  await expect(entries.nth(1)).toContainText("Reason: spamming");
  await alice.keyboard.press("Escape");

  await joinServer(bob, code);
});
