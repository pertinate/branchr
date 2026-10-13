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

  await alice.getByPlaceholder("Message #general").fill("hi :OMEGALUL: :bttvJAM: and plain OMEGALUL stays text");
  await alice.keyboard.press("Enter");
  // Only :name: is an emote; the bare word stays text (strict locators below also
  // ensure there's exactly one OMEGALUL image).
  await expect(bob.getByText("and plain OMEGALUL stays text")).toBeVisible();
  for (const [name, cdn] of [
    ["OMEGALUL", "cdn.frankerfacez.com/emote/"],
    ["bttvJAM", "cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/"],
  ]) {
    const img = bob.locator(`img[alt="${name}"]`);
    await expect(img).toBeVisible();
    expect(await img.getAttribute("src")).toContain(cdn);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  }

  // Pinned, its emotes still show.
  await alice.getByText("and plain OMEGALUL stays text").click({ button: "right" });
  await alice.getByRole("menuitem", { name: "Pin Message" }).click();
  await alice.getByRole("button", { name: "Pinned Messages" }).click();
  await expect(alice.getByTestId("found-message").locator('img[alt="OMEGALUL"]')).toBeVisible();
  await expect(alice.getByTestId("found-message").locator('img[alt="bttvJAM"]')).toBeVisible();
});

test("emotes: usable across servers, with source shown and no forging", async ({ browser }) => {
  const alice = await register(browser, "xg_a");
  await createServer(alice, "Emote Home");
  // Alice adds an emote to her first server.
  await alice.getByRole("button", { name: "Emote Home" }).click();
  await alice.getByRole("menuitem", { name: "Emotes" }).click();
  await alice.getByLabel("Emote link").fill("https://www.frankerfacez.com/emoticon/128054-OMEGALUL");
  await alice.getByRole("button", { name: "Add", exact: true }).click();
  await expect(alice.getByTestId("server-emotes").locator('img[alt="OMEGALUL"]')).toHaveCount(1);
  await alice.keyboard.press("Escape");

  // A second server that Bob joins (he is not in Emote Home).
  const code = await createServer(alice, "Hangout");
  const bob = await register(browser, "xg_b");
  await joinServer(bob, code);

  // Autocomplete offers the other server's emote, labelled with its server.
  const box = alice.getByPlaceholder("Message #general");
  await box.fill("look :OMEGA");
  await expect(alice.getByRole("button", { name: /OMEGALUL.*Emote Home/ })).toBeVisible();
  await box.press("Tab");
  await expect(box).toHaveValue(/^look <:OMEGALUL:\d+> $/);
  await box.press("Enter");

  // Bob renders it from the message's snapshot, and the card hides its source.
  const bobImg = bob.locator('img[alt="OMEGALUL"]');
  await expect(bobImg).toBeVisible();
  expect(await bobImg.getAttribute("src")).toContain("cdn.frankerfacez.com/emote/128054/");
  await bobImg.click();
  await expect(bob.getByRole("dialog", { name: "Emote OMEGALUL" })).toContainText("A community you're not in");
  await bob.keyboard.press("Escape");

  // Alice's card names the source server.
  await alice.locator('img[alt="OMEGALUL"]').last().click();
  const card = alice.getByRole("dialog", { name: "Emote OMEGALUL" });
  await expect(card.getByTestId("emote-card-guild")).toContainText("Emote Home");
  await expect(card).toContainText("FrankerFaceZ");
  await alice.keyboard.press("Escape");

  // Bob can't use it by forging a token: the server turns it into plain text.
  const id = await alice.locator('img[alt="OMEGALUL"]').last().getAttribute("data-emote-id");
  await bob.getByPlaceholder("Message #general").fill(`forged <:OMEGALUL:${id}>`);
  await bob.keyboard.press("Enter");
  await expect(alice.getByText("forged :OMEGALUL:")).toBeVisible();

  // Alice reacts with it from the picker (grouped by server); Bob sees it via lookup.
  const msg = alice.getByText("look").first();
  await msg.hover();
  await alice.getByTitle("Add Reaction").first().click();
  await alice.getByRole("region", { name: "Emote Home emotes" }).getByRole("button").first().click();
  const reaction = bob.locator("button", { has: bob.locator('img[alt="OMEGALUL"]') }).filter({ hasText: "1" });
  await expect(reaction).toBeVisible();
  // ...and can +1 an existing reaction even though he isn't in Emote Home.
  await reaction.click();
  await expect(alice.locator("button", { has: alice.locator('img[alt="OMEGALUL"]') }).filter({ hasText: "2" })).toBeVisible();
});

test("emotes: name clashes prompt for a new name; owners can rename", async ({ browser }) => {
  const alice = await register(browser, "rn_a");
  const code = await createServer(alice, "Rename Test");
  const bob = await register(browser, "rn_b");
  await joinServer(bob, code);
  await alice.getByRole("button", { name: "Rename Test" }).click();
  await alice.getByRole("menuitem", { name: "Emotes" }).click();
  const serverEmotes = alice.getByTestId("server-emotes");

  await alice.getByLabel("Emote link").fill("https://www.frankerfacez.com/emoticon/128054-OMEGALUL");
  await alice.getByRole("button", { name: "Add", exact: true }).click();
  await expect(serverEmotes.locator('img[alt="OMEGALUL"]')).toHaveCount(1);

  // A different emote with the same name: asked for another name instead of failing.
  await alice.getByPlaceholder("Search 7TV emotes…").fill("OMEGALUL");
  await alice.getByTestId("emote-results").locator("button", { hasText: /^OMEGALUL$/ }).first().click();
  const newName = alice.getByLabel("New emote name");
  await expect(newName).toHaveValue("OMEGALUL2");
  await newName.fill("OMEGA7");
  await newName.press("Enter");
  await expect(serverEmotes.locator('img[alt="OMEGA7"]')).toHaveCount(1);
  await expect(newName).toBeHidden();

  // Inline rename, seen live by other members.
  await serverEmotes.getByRole("button", { name: "OMEGA7", exact: true }).click();
  const rename = alice.getByLabel("Rename OMEGA7");
  await rename.fill("SevenLUL");
  await rename.press("Enter");
  await expect(serverEmotes.locator('img[alt="SevenLUL"]')).toHaveCount(1);
  // Renaming onto a taken name is refused and reverts.
  await serverEmotes.getByRole("button", { name: "SevenLUL", exact: true }).click();
  await alice.getByLabel("Rename SevenLUL").fill("OMEGALUL");
  await alice.getByLabel("Rename SevenLUL").press("Enter");
  await expect(alice.getByText("an emote named OMEGALUL already exists")).toBeVisible();
  await expect(serverEmotes.locator('img[alt="SevenLUL"]')).toHaveCount(1);
  await alice.keyboard.press("Escape");

  // Autocomplete inserts this server's emote as :name:.
  const box = bob.getByPlaceholder("Message #general");
  await box.fill(":Seven");
  await box.press("Tab");
  await expect(box).toHaveValue(":SevenLUL: ");
  await box.press("Enter");
  await expect(alice.locator('img[alt="SevenLUL"]').last()).toBeVisible();
});
