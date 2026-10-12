import { expect, test } from "@playwright/test";

import { createServer, joinServer, register } from "./helpers";

test("links get previews, from the server's copy of the picture", async ({ browser }) => {
  const alice = await register(browser, "emb_a");
  const code = await createServer(alice, "Previews");
  const bob = await register(browser, "emb_b");
  await joinServer(bob, code);

  await alice.getByPlaceholder("Message #general").fill("look http://localhost:18072/preview/page and <http://localhost:18072/preview/pic.png>");
  await alice.getByPlaceholder("Message #general").press("Enter");
  for (const page of [alice, bob]) {
    const embed = page.getByTestId("embed");
    // Only the first link: the second is wrapped in <…>, which opts out.
    await expect(embed).toHaveCount(1);
    await expect(embed).toContainText("Mock Site");
    await expect(embed.getByRole("link", { name: "A page worth sharing" })).toHaveAttribute("href", "http://localhost:18072/preview/page");
    await expect(embed).toContainText("Everything you'd want to know.");
    const img = embed.locator("img");
    await expect(img).toHaveAttribute("src", /\/api\/files\/embed\//);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  }

  // A link straight to a picture shows just the picture; editing the link away drops it.
  await bob.getByPlaceholder("Message #general").fill("http://localhost:18072/preview/pic.png");
  await bob.getByPlaceholder("Message #general").press("Enter");
  await expect(alice.getByTestId("embed")).toHaveCount(2);
  await bob.getByPlaceholder("Message #general").press("ArrowUp");
  await bob.keyboard.press("ControlOrMeta+a");
  await bob.keyboard.type("never mind");
  await bob.keyboard.press("Enter");
  await expect(alice.getByText("never mind")).toBeVisible();
  await expect(alice.getByTestId("embed")).toHaveCount(1);
});
