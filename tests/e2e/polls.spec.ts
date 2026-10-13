import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

test("polls: create one, vote, change your vote, take it back", async ({ browser }) => {
  const alice = await register(browser, "poll_a");
  const code = await createServer(alice, "Votes");
  const bob = await register(browser, "poll_b");
  await joinServer(bob, code);
  await expect(bob.getByPlaceholder("Message #general")).toBeVisible();

  await alice.getByRole("button", { name: "Create a poll" }).click();
  await alice.getByLabel("Question").fill("Pizza or tacos?");
  await alice.getByLabel("Answer 1", { exact: true }).fill("Pizza");
  await alice.getByLabel("Answer 2", { exact: true }).fill("Tacos");
  await alice.getByRole("button", { name: "Add answer" }).click();
  await alice.getByLabel("Answer 3", { exact: true }).fill("Both");
  await alice.getByRole("button", { name: "Post" }).click();

  const bobPoll = bob.getByTestId("poll");
  const alicePoll = alice.getByTestId("poll");
  await expect(bobPoll).toContainText("Pizza or tacos?");
  await expect(bobPoll).toContainText("0 votes");

  // Bob votes; both see it.
  await bobPoll.getByRole("button", { name: /^Tacos/ }).click();
  await expect(bobPoll.getByRole("button", { name: /^Tacos/ })).toHaveAttribute("aria-pressed", "true");
  await expect(alicePoll).toContainText("1 vote ·");

  // One answer only: picking another moves the vote.
  await bobPoll.getByRole("button", { name: /^Both/ }).click();
  await expect(bobPoll.getByRole("button", { name: /^Tacos/ })).toHaveAttribute("aria-pressed", "false");
  await expect(alicePoll).toContainText("1 vote ·");
  // Alice votes too and sees the split.
  await alicePoll.getByRole("button", { name: /^Pizza/ }).click();
  await expect(bobPoll).toContainText("2 votes");
  await expect(alicePoll.getByRole("button", { name: /^Both/ })).toContainText("1 · 50%");

  // Taking a vote back; it stays that way after a reload.
  await bobPoll.getByRole("button", { name: /^Both/ }).click();
  await expect(alicePoll).toContainText("1 vote ·");
  await bob.reload();
  await expect(bob.getByTestId("poll")).toContainText("1 vote ·");
  await expect(bob.getByTestId("poll").getByRole("button", { name: /^Pizza/ })).toHaveAttribute("aria-pressed", "false");
});
