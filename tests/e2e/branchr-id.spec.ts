import { expect, test } from "@playwright/test";

import { createServer, forgetSessions, register, session, sessions, openUserSettings } from "./helpers";

test.skip(!process.env.TEST_DATABASE_URL, "branchr ID needs TEST_DATABASE_URL (Postgres)");

test("branchr account: sign in with Discord, survive a reload, sign out", async ({ browser }) => {
  const page = await register(browser, "bid");
  await createServer(page, "Accounts");
  await openUserSettings(page);
  const card = page.getByTestId("branchr-account");

  // Web flow: off to branchr ID, (fake) Discord approves, back here with a code.
  await card.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByText("Signed in to branchr as E2E Nelly")).toBeVisible();
  // The code doesn't linger in the address bar.
  expect(new URL(page.url()).search).toBe("");

  // The refresh token persists: after a fresh load the app mints access tokens with it, which
  // is what connects friends and DMs (rotating it by hand here would race the app doing so).
  await page.reload();
  await page.getByRole("link", { name: "Direct Messages" }).click();
  await expect(page.getByRole("tab", { name: "Add Friend" })).toBeVisible();
  await page.goBack();
  // Settle on the server again before reaching for the account dock.
  await expect(page.getByRole("heading", { name: /^Welcome to #/ })).toBeVisible();

  await openUserSettings(page);
  await expect(card.getByText("E2E Nelly")).toBeVisible();
  await expect(card.getByText("Signed in with Discord")).toBeVisible();
  await card.getByRole("button", { name: "Sign out" }).click();
  await expect(card.getByRole("button", { name: "Sign in with Discord" })).toBeVisible();
});

const FED = "http://localhost:18081";
const ID = "http://localhost:18070";

test("federated server: sign in with Discord from the login screen, claim it, come back as the same user", async ({ browser }) => {
  const { readFileSync, existsSync } = await import("node:fs");
  const claimFile = `${process.env.E2E_FEDERATED_DIR}/claim-code.txt`;
  // The server registers with branchr ID in the background.
  await expect.poll(async () => (await (await fetch(`${FED}/api/instance`)).json()).instanceId, { timeout: 30_000 }).toBeTruthy();
  const info = await (await fetch(`${FED}/api/instance`)).json();
  expect(info).toMatchObject({ authMode: "both", branchrIdUrl: ID, claimed: false });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/#/login");
  await page.getByLabel("Server", { exact: true }).fill(FED);
  // Not signed in to branchr yet: Discord first, then straight on into the server.
  await page.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByRole("heading", { name: "No servers yet" })).toBeVisible();
  const current = () => session(page);
  const first = await current();
  expect(first.url).toBe(FED);
  expect(first.user.displayName).toBe("E2E Nelly");
  expect(first.user.username).toMatch(/^e2e_nelly\d*$/);

  // The owner claims the server with the code it wrote out, from User Settings.
  const code = readFileSync(claimFile, "utf8").trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await createServer(page, "Federated home");
  await openUserSettings(page);
  await page.getByLabel(/Claim a server you host/).fill(code.toLowerCase());
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByText("You now own e2e federated")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await (await fetch(`${FED}/api/instance`)).json()).claimed, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => existsSync(claimFile)).toBe(false);

  // The owner manages the host: someone with a password account misbehaves there.
  const run = Date.now().toString(36);
  const bad = await (await browser.newContext()).newPage();
  await bad.goto("/#/login");
  await bad.getByLabel("Server", { exact: true }).fill(FED);
  await bad.getByRole("button", { name: "Register" }).click();
  await bad.getByLabel("Username").fill(`spammer_${run}`);
  await bad.getByLabel("Password").fill("correct horse battery");
  await bad.getByRole("button", { name: "Continue" }).click();
  await createServer(bad, "Spam Palace");

  await openUserSettings(page);
  const ours = page.getByTestId("owned-host").filter({ hasText: "localhost:18081" });
  await expect(ours.getByText("e2e federated")).toBeVisible();
  await ours.getByRole("button", { name: "Manage" }).click();
  const admin = page.getByTestId("host-admin");
  await expect(admin.getByText("Open registration")).toBeVisible();
  await expect(admin.getByText("Discord or a password")).toBeVisible();

  // Ban: they're logged out at once and can't log back in.
  page.on("dialog", (d) => void d.accept(d.type() === "prompt" ? "spam" : undefined));
  await admin.getByRole("tab", { name: "Members" }).click();
  await admin.getByLabel("Search people").fill(`spammer_${run}`);
  const row = admin.getByTestId("host-user").filter({ hasText: `spammer_${run}` });
  await row.getByRole("button", { name: "Ban" }).click();
  await expect(row.getByText("Banned")).toBeVisible();
  await expect(bad.getByRole("heading", { name: /Welcome back|Create an account/ })).toBeVisible({ timeout: 30_000 });
  await bad.getByLabel("Server", { exact: true }).fill(FED);
  await bad.getByLabel("Username").fill(`spammer_${run}`);
  await bad.getByLabel("Password").fill("correct horse battery");
  await bad.getByRole("button", { name: "Log In" }).click();
  await expect(bad.getByText("you're banned from this host")).toBeVisible();

  // Remove their server, then unban.
  await admin.getByRole("tab", { name: "Servers" }).click();
  await admin.getByLabel("Search servers").fill("Spam Palace");
  await admin.getByRole("button", { name: "Delete Spam Palace" }).click();
  await expect(admin.getByTestId("host-guild")).toHaveCount(0);
  await admin.getByRole("tab", { name: "Members" }).click();
  await row.getByRole("button", { name: "Unban" }).click();
  await expect(row.getByRole("button", { name: "Ban" })).toBeVisible();
  await bad.getByRole("button", { name: "Log In" }).click();
  await expect(bad.getByRole("heading", { name: "No servers yet" })).toBeVisible();

  // The owner makes them a moderator: they can manage people, but not servers or the owner.
  await row.getByLabel(`Host role for ${`spammer_${run}`}`).click();
  await page.getByRole("option", { name: "Moderator" }).click();
  await expect(row.locator("[data-slot=badge]").filter({ hasText: "Moderator" })).toBeVisible();
  await bad.getByRole("button", { name: "Your account" }).click({ button: "right" });
  await bad.getByRole("menuitem", { name: "Manage Host" }).click();
  const modView = bad.getByTestId("host-admin");
  await expect(modView.getByText("You're a moderator here")).toBeVisible();
  await expect(modView.getByRole("tab", { name: "Servers" })).toHaveCount(0);
  await modView.getByRole("tab", { name: "Members" }).click();
  const ownerRow = modView.getByTestId("host-user").filter({ hasText: "Owner" });
  await expect(ownerRow).toBeVisible();
  await expect(ownerRow.getByRole("button", { name: "Ban" })).toHaveCount(0);
  await bad.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Log out of the server and back in: same user, no second Discord trip (already signed in).
  await forgetSessions(page);
  await page.goto("/#/login");
  await page.reload();
  await page.getByLabel("Server", { exact: true }).fill(FED);
  await page.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  expect((await current()).user.id).toBe(first.user.id);

  await ctx.close();
});

test("federated server: a password account links to branchr and is reached by Discord sign-in", async ({ browser }) => {
  const run = Date.now().toString(36);
  // A Discord identity no other test uses.
  await fetch("http://localhost:18071/next-user", {
    method: "POST",
    body: JSON.stringify({ id: `9${Date.now()}`, username: `linker_${run}`, global_name: "Link Tester" }),
  });
  await expect.poll(async () => (await (await fetch(`${FED}/api/instance`)).json()).instanceId, { timeout: 30_000 }).toBeTruthy();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/#/login");
  await page.getByLabel("Server", { exact: true }).fill(FED);
  await page.getByRole("button", { name: "Register" }).click();
  await page.getByLabel("Username").fill(`pw_${run}`);
  await page.getByLabel("Display name").fill("Password Person");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();
  await createServer(page, "Linked home");
  const current = () => session(page);
  const local = await current();

  // Sign in to branchr from Settings (a full redirect; still logged in to the server after).
  await openUserSettings(page);
  await page.getByTestId("branchr-account").getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByText("Signed in to branchr as Link Tester")).toBeVisible();
  await openUserSettings(page);
  await page.getByTestId("branchr-account").getByRole("button", { name: "Link" }).click();
  await expect(page.getByText("This server account is linked")).toBeVisible();

  // Someone else on this server can't take the same branchr account.
  const conflict = await page.evaluate(
    async ({ fed, id, run }) => {
      const s = JSON.parse(localStorage.getItem("branchr-id") ?? "{}").state;
      const t = await (await fetch(`${id}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken }) })).json();
      localStorage.setItem("branchr-id", JSON.stringify({ state: { ...s, refreshToken: t.refresh_token }, version: 0 }));
      const info = await (await fetch(`${fed}/api/instance`)).json();
      const pass = (await (await fetch(`${id}/instances/${info.instanceId}/token`, { method: "POST", headers: { authorization: `Bearer ${t.access_token}` } })).json()).token;
      const other = await (
        await fetch(`${fed}/api/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: `pw2_${run}`, password: "correct horse battery" }),
        })
      ).json();
      const r = await fetch(`${fed}/api/auth/link`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${other.token}` },
        body: JSON.stringify({ token: pass }),
      });
      return r.status;
    },
    { fed: FED, id: ID, run },
  );
  expect(conflict).toBe(409);

  // Log out of the server; Discord sign-in now reaches the password account.
  await forgetSessions(page);
  await page.goto("/#/login");
  await page.reload();
  await page.getByLabel("Server", { exact: true }).fill(FED);
  await page.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  const back = await current();
  expect(back.user.id).toBe(local.user.id);
  expect(back.user.username).toBe(`pw_${run}`);
  // Now carrying the branchr profile.
  expect(back.user.displayName).toBe("Link Tester");

  await fetch("http://localhost:18071/next-user", { method: "POST" });
  await ctx.close();
});

test("a new device reconnects to every host used with the branchr account", async ({ browser }) => {
  const HOME = "http://localhost:18080";
  const id = `7${Date.now()}`;
  await fetch("http://localhost:18071/next-user", {
    method: "POST",
    body: JSON.stringify({ id, username: `roamer_${id.slice(-6)}`, global_name: "Roamer" }),
  });
  for (const host of [FED, HOME]) {
    await expect.poll(async () => (await (await fetch(`${host}/api/instance`)).json()).instanceId, { timeout: 30_000 }).toBeTruthy();
  }

  // First device: Discord into one host, then connect a second the same way.
  const one = await (await browser.newContext()).newPage();
  await one.goto("/#/login");
  await one.getByLabel("Server", { exact: true }).fill(FED);
  await one.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(one.getByRole("heading", { name: "No servers yet" })).toBeVisible();
  await one.getByRole("button", { name: "Add a Server" }).click();
  await one.getByRole("tab", { name: "Connect" }).click();
  await one.getByLabel("Host address").fill(HOME);
  await one.getByRole("button", { name: "Continue" }).click();
  await one.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(one).toHaveURL(/localhost-18080/);
  await one.getByRole("link", { name: "My Guilds" }).click();
  await expect(one.getByTestId("host-section")).toHaveCount(2);

  // A new device: sign in to one host, and the other comes along.
  const two = await (await browser.newContext()).newPage();
  await two.goto("/#/login");
  await two.getByLabel("Server", { exact: true }).fill(FED);
  await two.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(two.getByRole("heading", { name: "No servers yet" })).toBeVisible();
  // Still on the host it signed in to.
  expect(two.url()).toContain("/localhost-18081");
  await two.getByRole("link", { name: "My Guilds" }).click();
  await expect(two.getByTestId("host-section")).toHaveCount(2);
  expect((await sessions(two)).map((s) => s.url).sort()).toEqual([FED, HOME].sort());

  // Logging out of a host on purpose forgets it for the account.
  two.on("dialog", (d) => void d.accept());
  await two.getByRole("button", { name: "Log Out of localhost:18080" }).click();
  await expect(two.getByTestId("host-section")).toHaveCount(1);
  const three = await (await browser.newContext()).newPage();
  await three.goto("/#/login");
  await three.getByLabel("Server", { exact: true }).fill(FED);
  await three.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(three.getByRole("heading", { name: "No servers yet" })).toBeVisible();
  await three.waitForTimeout(1500);
  expect((await sessions(three)).map((s) => s.url)).toEqual([FED]);

  await fetch("http://localhost:18071/next-user", { method: "POST" });
});
