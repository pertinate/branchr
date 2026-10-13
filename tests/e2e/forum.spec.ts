import { expect, test } from "@playwright/test";

import { createServer, joinServer, register, session } from "./helpers";

test("forums: create one, start a post, others see and reply to it", async ({ browser }) => {
  const alice = await register(browser, "forum_a");
  const code = await createServer(alice, "Askers");
  const bob = await register(browser, "forum_b");
  await joinServer(bob, code);

  await alice.getByTestId("channel-list").click({ button: "right", position: { x: 100, y: 420 } });
  await alice.getByRole("menuitem", { name: "Create Channel" }).click();
  await alice.getByRole("button", { name: /^forum/i }).click();
  await alice.getByPlaceholder("new-channel").fill("Help Desk");
  await alice.getByRole("button", { name: "Create Channel" }).click();
  await expect(alice.getByText("No posts yet.")).toBeVisible();

  await alice.getByRole("button", { name: "New Post" }).click();
  await alice.getByRole("textbox", { name: "Title", exact: true }).fill("Voice keeps cutting out");
  await alice.getByRole("textbox", { name: "Message", exact: true }).fill("Since this morning, every few minutes.");
  await alice.getByRole("button", { name: "Post", exact: true }).click();
  // Into the post, with its first message.
  await expect(alice.getByText("Since this morning, every few minutes.")).toBeVisible();
  await expect(alice.getByPlaceholder("Message #Voice keeps cutting out")).toBeVisible();

  // Bob: the forum is unread; its posts are listed, not in the channel list.
  const forum = bob.getByRole("link", { name: "help-desk", exact: true });
  await expect(forum).toHaveAttribute("data-unread", "true");
  await expect(bob.getByTestId("channel-list")).not.toContainText("Voice keeps cutting out");
  await forum.click();
  await bob.getByTestId("forum-post").filter({ hasText: "Voice keeps cutting out" }).click();
  await expect(bob.getByText("Since this morning, every few minutes.")).toBeVisible();
  await bob.getByPlaceholder("Message #Voice keeps cutting out").fill("Try another region?");
  await bob.getByPlaceholder("Message #Voice keeps cutting out").press("Enter");
  await expect(alice.getByText("Try another region?")).toBeVisible();
  // Back to the forum from the post.
  await bob.getByRole("link", { name: "help-desk" }).first().click();
  await expect(bob.getByTestId("forum-post")).toHaveCount(1);
  await expect(forum).not.toHaveAttribute("data-unread", "true");

  // A post needs a title.
  const s = await session(bob);
  const forumId = bob.url().split("/").pop();
  const status = await bob.evaluate(
    async ([url, token, id]) =>
      (await fetch(`${url}/api/channels/${id}/threads`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status,
    [s.url, s.token, forumId] as const,
  );
  expect(status).toBe(400);
});
