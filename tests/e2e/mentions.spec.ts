import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

const channelRow = (p: Page, name: string) => p.getByRole("link", { name: new RegExp(`^${name}\\b`) });

test("mentions: autocomplete, pills, highlight, badges, and pings while offline", async ({ browser }) => {
  const alice = await register(browser, "men_a");
  const code = await createServer(alice, "Mentions");
  await alice.getByRole("button", { name: "Mentions" }).click();
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByPlaceholder("new-channel").fill("random");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await expect(alice.getByPlaceholder("Message #random")).toBeVisible();
  await channelRow(alice, "general").click();

  const bob = await register(browser, "men_b");
  await joinServer(bob, code);
  await channelRow(bob, "random").click();
  await expect(bob.getByPlaceholder("Message #random")).toBeVisible();

  // @ suggests members; picking one inserts their unique username.
  const box = alice.getByPlaceholder("Message #general");
  await box.fill("hey @men_b");
  await expect(alice.getByText("Members")).toBeVisible();
  await box.press("Tab");
  await expect(box).toHaveValue(/^hey @men_b_\w+ $/);
  await box.pressSequentially("look");
  await box.press("Enter");

  // Rendered as a pill with the display name, for both of them.
  await expect(alice.locator("[data-mention]").filter({ hasText: "@men_b" })).toBeVisible();

  // Bob, in another channel, gets a badge on the channel, the server and the title.
  await expect(channelRow(bob, "general").getByTestId("mention-badge")).toHaveText("1");
  await expect(bob.getByRole("link", { name: "Mentions" }).getByTestId("mention-badge")).toHaveText("1");
  await expect(bob).toHaveTitle(/^\(1\) /);

  // Opening the channel shows the highlighted message and clears everything.
  await channelRow(bob, "general").click();
  await expect(bob.locator("[data-pinged]").filter({ hasText: "look" })).toBeVisible();
  await expect(bob.getByTestId("mention-badge")).toHaveCount(0);
  await expect(bob).not.toHaveTitle(/^\(/);

  // Mentions inside code don't count; unknown names stay text.
  await box.fill("`@everyone` and @nobody_here_at_all");
  await box.press("Enter");
  await expect(bob.getByText("and @nobody_here_at_all")).toBeVisible();
  await expect(bob.locator("[data-pinged]")).toHaveCount(1);

  // Offline: @everyone still counts when Bob comes back; @here only reached people online.
  await channelRow(bob, "random").click();
  await expect(bob.getByPlaceholder("Message #random")).toBeVisible();
  const where = bob.url();
  const ctx = bob.context();
  await bob.close();
  await box.fill("@here anyone?");
  await box.press("Enter");
  await box.fill("@everyone wake up");
  await box.press("Enter");
  await expect(alice.locator("[data-mention='everyone']")).toBeVisible();

  const back = await ctx.newPage();
  await back.goto(where);
  await expect(back.getByPlaceholder("Message #random")).toBeVisible();
  await expect(channelRow(back, "general").getByTestId("mention-badge")).toHaveText("1");

  // Reading it on one device clears it on the others.
  const other = await ctx.newPage();
  await other.goto(where);
  await expect(channelRow(other, "general").getByTestId("mention-badge")).toHaveText("1");
  await channelRow(back, "general").click();
  await expect(back.locator("[data-pinged]").filter({ hasText: "wake up" })).toBeVisible();
  await expect(other.getByTestId("mention-badge")).toHaveCount(0);
});

test("mentions: replies ping the author; edits keep mentions editable", async ({ browser }) => {
  const alice = await register(browser, "rep_a");
  const code = await createServer(alice, "Replies");
  const bob = await register(browser, "rep_b");
  await joinServer(bob, code);

  await bob.getByPlaceholder("Message #general").fill("original from bob");
  await bob.keyboard.press("Enter");
  const msg = alice.getByText("original from bob");
  await msg.hover();
  await alice.getByRole("button", { name: "Reply" }).click();
  await alice.getByPlaceholder("Message #general").fill("a reply");
  await alice.keyboard.press("Enter");
  await expect(bob.locator("[data-pinged]").filter({ hasText: "a reply" })).toBeVisible();

  // Editing shows @username, not the raw <@id>, and saving keeps the mention.
  const box = alice.getByPlaceholder("Message #general");
  await box.fill("ping @rep_b");
  await box.press("Tab");
  await box.pressSequentially("again");
  await box.press("Enter");
  await expect(alice.locator("[data-mention]").filter({ hasText: "@rep_b" }).last()).toBeVisible();
  // Up-arrow edits your last *sent* message: wait for the server to have it.
  await expect(bob.getByText("again")).toBeVisible();
  await box.press("ArrowUp");
  const edit = alice.locator("textarea:not([placeholder])");
  await expect(edit).toHaveValue(/^ping @rep_b_\w+ again$/);
  await edit.press("End");
  await edit.pressSequentially("!");
  await edit.press("Enter");
  await expect(bob.locator("[data-pinged]").filter({ hasText: "again!" })).toBeVisible();
});

test("mentions: the owner can stop members from pinging @everyone", async ({ browser }) => {
  const alice = await register(browser, "evr_a");
  const code = await createServer(alice, "Quiet");
  const bob = await register(browser, "evr_b");
  await joinServer(bob, code);

  // On by default: members can ping everyone.
  await bob.getByPlaceholder("Message #general").fill("@everyone first");
  await bob.keyboard.press("Enter");
  await expect(alice.locator("[data-pinged]").filter({ hasText: "first" })).toBeVisible();
  await expect(alice.locator("[data-mention='everyone']")).toHaveCount(1);

  await alice.getByRole("button", { name: "Quiet" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByLabel("Anyone can mention @everyone and @here").click();
  await expect(alice.getByLabel("Anyone can mention @everyone and @here")).not.toBeChecked();
  await alice.keyboard.press("Escape");

  // Off: Bob's @here is plain text, isn't suggested, and pings nobody.
  const box = bob.getByPlaceholder("Message #general");
  await box.fill("@he");
  await expect(bob.getByText("Notifies everyone online")).toHaveCount(0);
  await box.fill("@here second");
  await box.press("Enter");
  await expect(alice.getByText("@here second")).toBeVisible();
  await expect(alice.locator("[data-pinged]")).toHaveCount(1);
  await expect(alice.locator("[data-mention='here']")).toHaveCount(0);

  // The owner still can.
  await alice.getByPlaceholder("Message #general").fill("@here third");
  await alice.keyboard.press("Enter");
  await expect(bob.locator("[data-pinged]").filter({ hasText: "third" })).toBeVisible();
});
