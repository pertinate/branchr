import { type Page, expect, test } from "@playwright/test";

import { register } from "./helpers";

test.skip(!process.env.TEST_DATABASE_URL, "branchr ID needs TEST_DATABASE_URL (Postgres)");

/** Signs `page` in to branchr from the Home view, as `as` (a cookie the mock Discord reads) or its default user. */
async function signIn(page: Page, as?: { id: string; username: string; global_name: string }) {
  if (as) await page.context().addCookies([{ name: "mock_discord_user", value: encodeURIComponent(JSON.stringify(as)), domain: "localhost", path: "/" }]);
  await page.getByRole("link", { name: "Direct Messages" }).click();
  await page.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByText(/^Signed in to branchr as/)).toBeVisible();
  await page.getByRole("link", { name: "Direct Messages" }).click();
}

test("friends and DMs: request, accept, chat live, edit, block", async ({ browser }) => {
  const run = Date.now().toString(36);
  const bobName = `E2E Bob ${run}`;
  const alice = await register(browser, "soc_a");
  await signIn(alice); // E2E Nelly
  const bob = await register(browser, "soc_b");
  await signIn(bob, { id: `9${Date.now()}`, username: `e2e_bob_${run}`, global_name: bobName });

  // Bob asks Nelly by handle.
  await bob.getByRole("tab", { name: "Add Friend" }).click();
  await bob.getByLabel("Friend's handle").fill("e2e_nelly");
  await bob.getByRole("button", { name: "Send Friend Request" }).click();
  await expect(bob.getByText("Friend request sent to e2e_nelly")).toBeVisible();

  // Nelly sees it under Pending and accepts.
  await alice.getByRole("tab", { name: /^Pending/ }).click();
  await alice.getByRole("button", { name: `Accept ${bobName}` }).click();
  await alice.getByRole("tab", { name: "Online" }).click();
  await expect(alice.getByTestId("friend-row").filter({ hasText: bobName })).toBeVisible();

  // Bob messages her; she gets it live, with an unread mark.
  await bob.getByRole("tab", { name: "Online" }).click();
  await bob.getByRole("button", { name: "Message E2E Nelly" }).click();
  await bob.getByPlaceholder("Message @E2E Nelly").fill("hello nelly");
  await bob.keyboard.press("Enter");
  await expect(bob.getByTestId("dm-message").filter({ hasText: "hello nelly" })).toBeVisible();
  const dm = alice.getByRole("link", { name: `Message ${bobName}` });
  await expect(dm.getByTestId("dm-unread")).toBeVisible();
  await expect(alice).toHaveTitle(/^\(1\) /);
  await dm.click();
  await expect(alice).not.toHaveTitle(/^\(/);
  await expect(alice.getByTestId("dm-message").filter({ hasText: "hello nelly" })).toBeVisible();
  await expect(dm.getByTestId("dm-unread")).toHaveCount(0);

  // She replies; he sees it, and her typing first.
  const box = alice.getByPlaceholder(`Message @${bobName}`);
  await box.pressSequentially("hi bob");
  await expect(bob.getByText("E2E Nelly is typing…")).toBeVisible();
  await box.press("Enter");
  await expect(bob.getByTestId("dm-message").filter({ hasText: "hi bob" })).toBeVisible();

  // Edits show for both.
  const mine = alice.getByTestId("dm-message").filter({ hasText: "hi bob" });
  await mine.hover();
  await mine.getByRole("button", { name: "Edit" }).click();
  await alice.getByLabel("Edit message").fill("hi bob!");
  await alice.getByLabel("Edit message").press("Enter");
  await expect(bob.getByTestId("dm-message").filter({ hasText: "hi bob!" })).toContainText("(edited)");

  // A group: naming the conversation makes one, and Bob gets it straight away.
  await alice.getByRole("button", { name: "Create DM" }).click();
  await alice.getByLabel(`Pick ${bobName}`).check();
  await alice.getByLabel("Group name").fill("Plans");
  await alice.getByRole("button", { name: "Create Group DM" }).click();
  await expect(alice.getByTestId("group-members")).toContainText(bobName);
  await alice.getByPlaceholder("Message Plans").fill("group hello");
  await alice.keyboard.press("Enter");
  await bob.getByRole("link", { name: "Message Plans" }).click();
  await expect(bob.getByTestId("dm-message").filter({ hasText: "group hello" })).toBeVisible();
  // Bob leaves; it's gone from his list, and from Nelly's member list.
  bob.on("dialog", (d) => void d.accept());
  await bob.getByRole("button", { name: "Leave Group" }).click();
  await expect(bob.getByRole("link", { name: "Message Plans" })).toHaveCount(0);
  await expect(alice.getByTestId("group-members")).not.toContainText(bobName);
  await alice.getByRole("link", { name: `Message ${bobName}` }).click();

  // Bob blocks her: she can't message him any more.
  await bob.getByRole("link", { name: "Friends" }).click();
  await bob.getByRole("tab", { name: "All" }).click();
  await bob.getByRole("button", { name: "Block E2E Nelly" }).click();
  await expect(bob.getByText("Blocked E2E Nelly")).toBeVisible();
  await box.fill("are you there?");
  await box.press("Enter");
  await expect(alice.getByText("you can't message them")).toBeVisible();
});
