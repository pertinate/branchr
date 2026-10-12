import { type Browser, type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register, sessions } from "./helpers";

const HOME = "http://localhost:8080";
const AWAY = "http://localhost:8081";
const run = Date.now().toString(36);

/** Registers on a specific instance from a fresh browser. */
async function registerOn(browser: Browser, server: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await page.goto("/#/login");
  await page.getByLabel("Server", { exact: true }).fill(server);
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(`${name}_${run}`);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  return page;
}

/** Adds another host from the rail's "Add a Server → Connect", registering there. */
async function connectHost(page: Page, server: string, name: string) {
  await page.getByRole("button", { name: "Add a Server" }).click();
  await page.getByRole("tab", { name: "Connect" }).click();
  await page.getByLabel("Host address").fill(server);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connect another host" })).toBeVisible();
  await expect(page.getByLabel("Server", { exact: true })).toHaveValue(server);
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(`${name}_${run}`);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
}

test("multiple instances: connect a second host, badges and voice across them, log out of one", async ({ browser }) => {
  const alice = await register(browser, "multi_a");
  await createServer(alice, "Home A");

  // A second host, alongside the first.
  await connectHost(alice, AWAY, "multi_a_away");
  await expect(alice.getByRole("heading", { name: "No servers yet" })).toBeVisible();
  await expect(alice.getByText("localhost:8081")).toBeVisible();
  expect((await sessions(alice)).map((s) => s.url)).toEqual([HOME, AWAY]);
  // The rail labels each host's group now there are two.
  await expect(alice.getByTestId("instance-header")).toHaveCount(2);

  // Creating a server lands on the host on screen.
  const code = await createServer(alice, "Away B");
  expect(alice.url()).toContain("/localhost-8081/");
  await expect(alice.getByRole("link", { name: "Home A" })).toBeVisible();
  await expect(alice.getByRole("link", { name: "Away B" })).toBeVisible();

  // Someone on the second host mentions Alice while she's looking at the first.
  const bob = await registerOn(browser, AWAY, "multi_b");
  await joinServer(bob, code);
  await alice.getByRole("link", { name: "Home A" }).click();
  await expect(alice.getByPlaceholder("Message #general")).toBeVisible();
  expect(alice.url()).toContain("/localhost-8080/");
  const awayName = (await sessions(alice))[1].user.username;
  await bob.getByPlaceholder("Message #general").fill(`@${awayName} over here`);
  await bob.getByPlaceholder("Message #general").press("Enter");
  await expect(alice.getByRole("link", { name: "Away B" }).getByTestId("mention-badge")).toHaveText("1");
  await expect(alice).toHaveTitle(/^\(1\) /);

  // Messages go to the host on screen.
  await alice.getByPlaceholder("Message #general").fill("hello home");
  await alice.getByPlaceholder("Message #general").press("Enter");
  await expect(alice.getByText("hello home")).toBeVisible();
  await expect(bob.getByText("hello home")).toHaveCount(0);

  // Voice on the first host stays up while reading the second.
  await alice.getByRole("link", { name: "General", exact: true }).click();
  await expect(alice.getByText("Voice Connected")).toBeVisible();
  await alice.getByRole("link", { name: "Away B" }).click();
  await expect(alice.getByText("over here")).toBeVisible();
  await expect(alice.getByText("Voice Connected")).toBeVisible();
  await expect(alice.getByText("· localhost:8080")).toBeVisible();
  // Reading it cleared the badge.
  await expect(alice.getByTestId("mention-badge")).toHaveCount(0);

  // Log out of the second host only: its servers go, the first host and its voice stay.
  alice.on("dialog", (d) => void d.accept());
  await alice.getByTestId("instance-header").last().click({ button: "right" });
  await alice.getByRole("menuitem", { name: /^Log Out of localhost:8081/ }).click();
  await expect(alice.getByRole("link", { name: "Away B" })).toHaveCount(0);
  await expect(alice.getByRole("link", { name: "Home A" })).toBeVisible();
  await expect(alice.getByTestId("instance-header")).toHaveCount(0);
  await expect(alice.getByText("Voice Connected")).toBeVisible();
  expect((await sessions(alice)).map((s) => s.url)).toEqual([HOME]);

  // An invite link for a host we're not on: connect to it, then straight into the server.
  const invite = await (async () => {
    await bob.getByRole("button", { name: "Away B" }).click();
    await bob.getByRole("menuitem", { name: "Invite People" }).click();
    await expect(bob.getByLabel("Invite code")).not.toHaveValue("");
    const c = await bob.getByLabel("Invite code").inputValue();
    await bob.keyboard.press("Escape");
    return c;
  })();
  await alice.getByRole("button", { name: "Add a Server" }).click();
  await alice.getByRole("tab", { name: "Join" }).click();
  await alice.getByPlaceholder("Invite code or link").fill(`${AWAY}/#/invite/${invite}`);
  await alice.getByRole("button", { name: "Join Server" }).click();
  await expect(alice.getByRole("heading", { name: "Connect another host" })).toBeVisible();
  await alice.getByLabel("Username").fill(`multi_a_away_${run}`);
  await alice.getByLabel("Password").fill("correct horse battery");
  await alice.getByRole("button", { name: "Log In" }).click();
  await expect(alice.getByText("over here")).toBeVisible();
  expect(alice.url()).toContain("/localhost-8081/");
  await expect(alice.getByRole("link", { name: "Away B" })).toBeVisible();
  await expect(alice.getByRole("link", { name: "Home A" })).toBeVisible();
});
