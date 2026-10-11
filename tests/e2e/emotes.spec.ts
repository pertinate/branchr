import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

// Talks to the real 7TV / BetterTTV / FrankerFaceZ APIs and CDNs.
test("emotes: add from 7TV, FFZ and BetterTTV, render for other members", async ({ browser }) => {
  const alice = await register(browser, "emo_a");
  const code = await createServer(alice, "Emote Test");
  const bob = await register(browser, "emo_b");
  await joinServer(bob, code);

  await alice.getByRole("button", { name: "Emote Test" }).click();
  await alice.getByRole("menuitem", { name: "Emotes" }).click();
  const results = alice.getByTestId("emote-results");
  const serverEmotes = alice.getByTestId("server-emotes");

  // 7TV search.
  await alice.getByPlaceholder("Search 7TV emotes…").fill("catJAM");
  await results.getByRole("button").first().click();
  await expect(serverEmotes.locator("img")).toHaveCount(1);

  // FFZ search.
  await alice.getByRole("tab", { name: "FrankerFaceZ" }).click();
  await alice.getByPlaceholder("Search FrankerFaceZ emotes…").fill("OMEGALUL");
  await results.locator("button", { hasText: /^OMEGALUL$/ }).first().click();
  await expect(serverEmotes.locator('img[alt="OMEGALUL"]')).toHaveCount(1);

  // BetterTTV by link: no public lookup, so a name is required.
  await alice.getByLabel("Emote link").fill("https://betterttv.com/emotes/5f1b0186cf6d2144653d2970");
  await expect(alice.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await alice.getByLabel("Emote name").fill("bttvJAM");
  await alice.getByRole("button", { name: "Add", exact: true }).click();
  await expect(serverEmotes.locator('img[alt="bttvJAM"]')).toHaveCount(1);
  await alice.keyboard.press("Escape");

  await alice.getByPlaceholder("Message #general").fill("hi OMEGALUL bttvJAM");
  await alice.keyboard.press("Enter");
  for (const [name, cdn] of [
    ["OMEGALUL", "cdn.frankerfacez.com/emote/"],
    ["bttvJAM", "cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/"],
  ]) {
    const img = bob.locator(`img[alt="${name}"]`);
    await expect(img).toBeVisible();
    expect(await img.getAttribute("src")).toContain(cdn);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  }
});
