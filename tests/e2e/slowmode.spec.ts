import { expect, test } from "@playwright/test";

import { createServer, joinServer, register, session } from "./helpers";

test("slow mode holds members to one message per interval; moderators aren't held", async ({ browser }) => {
  const alice = await register(browser, "slow_a");
  const code = await createServer(alice, "Slow");
  const bob = await register(browser, "slow_b");
  await joinServer(bob, code);

  await alice.getByRole("link", { name: /^general\b/ }).click({ button: "right" });
  await alice.getByRole("menuitem", { name: "Edit Channel", exact: true }).click();
  await alice.getByLabel("Slow mode").click();
  await alice.getByRole("option", { name: "30 seconds" }).click();
  await alice.getByRole("button", { name: "Save" }).click();
  await expect(bob.getByTestId("slowmode")).toHaveText("Slow mode");
  // The owner isn't held, so sees no indicator.
  await expect(alice.getByTestId("slowmode")).toHaveCount(0);

  const box = bob.getByPlaceholder("Message #general");
  await box.fill("first");
  await box.press("Enter");
  await expect(alice.getByText("first")).toBeVisible();
  await expect(bob.getByTestId("slowmode")).toHaveText(/^\s*\d+s$/);
  // Too soon: it stays in the box, unsent.
  await box.fill("second");
  await box.press("Enter");
  await expect(box).toHaveValue("second");

  // The server holds the line too.
  const s = await session(bob);
  const channelId = bob.url().split("/").pop();
  const r = await bob.evaluate(
    async ([url, token, cid]) => (await fetch(`${url}/api/channels/${cid}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ content: "sneaky" }) })).status,
    [s.url, s.token, channelId] as const,
  );
  expect(r).toBe(429);

  // Alice sends back to back.
  for (const t of ["mod one", "mod two"]) {
    await alice.getByPlaceholder("Message #general").fill(t);
    await alice.getByPlaceholder("Message #general").press("Enter");
  }
  await expect(bob.getByText("mod two")).toBeVisible();
});
