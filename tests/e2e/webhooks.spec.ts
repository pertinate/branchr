import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

const post = (url: string, body: object) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("webhooks post into a channel by URL; reset and delete revoke it", async ({ browser }) => {
  const alice = await register(browser, "hook_a");
  const code = await createServer(alice, "Hooks");
  const bob = await register(browser, "hook_b");
  await joinServer(bob, code);

  await alice.getByRole("button", { name: "Hooks" }).click();
  await alice.getByRole("menuitem", { name: "Server Settings" }).click();
  await alice.getByRole("tab", { name: "Webhooks" }).click();
  await alice.getByLabel("Webhook name").fill("Deploy bot");
  await alice.getByRole("button", { name: "New Webhook" }).click();
  const urlBox = alice.getByLabel("Deploy bot URL", { exact: true });
  await expect(urlBox).toHaveValue(/\/api\/webhooks\/\d+\/[0-9a-f]{64}$/);
  const url = await urlBox.inputValue();

  // A post, under its own name for this message.
  expect((await post(url, { content: "build passed", username: "CI" })).status).toBe(204);
  const msg = bob.locator('[data-testid="bot-tag"]').first();
  await expect(bob.getByText("build passed")).toBeVisible();
  await expect(msg).toBeVisible();
  await expect(bob.getByText("CI", { exact: true })).toBeVisible();
  const waited = await post(`${url}?wait=true`, { content: "and deployed" });
  const body = await waited.json();
  expect(body.author.bot).toBe(true);
  expect(body.author.displayName).toBe("Deploy bot");
  await expect(bob.getByText("and deployed")).toBeVisible();
  expect((await post(url.replace(/[0-9a-f]{64}$/, "0".repeat(64)), { content: "nope" })).status).toBe(404);

  // A new URL; the old one stops working.
  await alice.getByRole("button", { name: "Reset Deploy bot URL" }).click();
  await expect(urlBox).not.toHaveValue(url);
  const url2 = await urlBox.inputValue();
  expect((await post(url, { content: "old" })).status).toBe(404);
  expect((await post(url2, { content: "new url works" })).status).toBe(204);
  await expect(bob.getByText("new url works")).toBeVisible();

  // Deleted: gone, its messages stay.
  alice.on("dialog", (d) => void d.accept());
  await alice.getByRole("button", { name: "Delete Deploy bot" }).click();
  await expect(alice.getByTestId("webhook")).toHaveCount(0);
  expect((await post(url2, { content: "after" })).status).toBe(404);
  await expect(bob.getByText("build passed")).toBeVisible();

  await alice.getByRole("tab", { name: "Audit Log" }).click();
  await expect(alice.getByText("created webhook")).toBeVisible();
  await expect(alice.getByText("deleted webhook")).toBeVisible();
});
