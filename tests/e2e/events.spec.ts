import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

test("events: schedule one in a voice channel, others mark interest, cancel it", async ({ browser }) => {
  const alice = await register(browser, "evt_a");
  const code = await createServer(alice, "Happenings");
  const bob = await register(browser, "evt_b");
  await joinServer(bob, code);

  await alice.getByRole("button", { name: "Events" }).click();
  await alice.getByRole("button", { name: "Create Event" }).click();
  await alice.getByLabel("Name").fill("Movie night");
  await alice.getByLabel("Description").fill("Bring snacks");
  await alice.getByRole("button", { name: "Create", exact: true }).click();
  const aliceEvent = alice.getByTestId("event");
  await expect(aliceEvent).toContainText("Movie night");
  await expect(aliceEvent).toContainText("General");

  // Bob sees it coming up, and is interested.
  await expect(bob.getByTestId("event-count")).toHaveText("1");
  await bob.getByRole("button", { name: "Events" }).click();
  await expect(bob.getByRole("button", { name: "Create Event" })).toHaveCount(0);
  const bobEvent = bob.getByTestId("event");
  await expect(bobEvent).toContainText("Bring snacks");
  await expect(bobEvent.getByRole("button", { name: "Cancel event" })).toHaveCount(0);
  await bobEvent.getByRole("button", { name: "Interested" }).click();
  await expect(bobEvent.getByRole("button", { name: "Interested" })).toHaveAttribute("aria-pressed", "true");
  await expect(aliceEvent).toContainText("1 interested");

  // Changes his mind; still there after a reload.
  await bobEvent.getByRole("button", { name: "Interested" }).click();
  await expect(aliceEvent).toContainText("0 interested");
  await bobEvent.getByRole("button", { name: "Interested" }).click();
  await bob.reload();
  await bob.getByRole("button", { name: "Events" }).click();
  await expect(bob.getByTestId("event").getByRole("button", { name: "Interested" })).toHaveAttribute("aria-pressed", "true");
  await bob.keyboard.press("Escape");

  // Cancelled: gone for everyone.
  alice.once("dialog", (d) => void d.accept());
  await aliceEvent.getByRole("button", { name: "Cancel event" }).click();
  await expect(aliceEvent).toHaveCount(0);
  await expect(bob.getByTestId("event-count")).toHaveCount(0);
});
