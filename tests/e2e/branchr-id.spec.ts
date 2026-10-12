import { expect, test } from "@playwright/test";

import { createServer, forgetSessions, register, session, sessions } from "./helpers";

test.skip(!process.env.TEST_DATABASE_URL, "branchr ID needs TEST_DATABASE_URL (Postgres)");

test("branchr account: sign in with Discord, survive a reload, sign out", async ({ browser }) => {
  const page = await register(browser, "bid");
  await createServer(page, "Accounts");
  await page.getByRole("button", { name: "Your account" }).hover();
  await page.getByRole("button", { name: "User Settings" }).click();
  const card = page.getByTestId("branchr-account");

  // Web flow: off to branchr ID, (fake) Discord approves, back here with a code.
  await card.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByText("Signed in to branchr as E2E Nelly")).toBeVisible();
  // The code doesn't linger in the address bar.
  expect(new URL(page.url()).search).toBe("");

  // The refresh token persists; a fresh load can mint access tokens with it.
  await page.reload();
  const token = await page.evaluate(async () => {
    const id = JSON.parse(localStorage.getItem("branchr-id") ?? "{}").state;
    const r = await fetch("http://localhost:8070/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: id.refreshToken }) });
    const t = await r.json();
    // Keep the rotated token, as the app would.
    localStorage.setItem("branchr-id", JSON.stringify({ state: { ...id, refreshToken: t.refresh_token }, version: 0 }));
    return t.access_token as string;
  });
  const me = await page.evaluate(async (t) => (await fetch("http://localhost:8070/me", { headers: { authorization: `Bearer ${t}` } })).json(), token);
  expect(me.displayName).toBe("E2E Nelly");

  await page.getByRole("button", { name: "Your account" }).hover();
  await page.getByRole("button", { name: "User Settings" }).click();
  await expect(card.getByText("E2E Nelly")).toBeVisible();
  await expect(card.getByText("Signed in with Discord")).toBeVisible();
  await card.getByRole("button", { name: "Sign out" }).click();
  await expect(card.getByRole("button", { name: "Sign in with Discord" })).toBeVisible();
});

const FED = "http://localhost:8081";
const ID = "http://localhost:8070";

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
  await page.getByRole("button", { name: "Your account" }).hover();
  await page.getByRole("button", { name: "User Settings" }).click();
  await page.getByLabel(/Claim a server you host/).fill(code.toLowerCase());
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByText("You now own e2e federated")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await (await fetch(`${FED}/api/instance`)).json()).claimed, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => existsSync(claimFile)).toBe(false);

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
  await fetch("http://localhost:8071/next-user", {
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
  await page.getByRole("button", { name: "Your account" }).hover();
  await page.getByRole("button", { name: "User Settings" }).click();
  await page.getByTestId("branchr-account").getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByText("Signed in to branchr as Link Tester")).toBeVisible();
  await page.getByRole("button", { name: "Your account" }).hover();
  await page.getByRole("button", { name: "User Settings" }).click();
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

  await fetch("http://localhost:8071/next-user", { method: "POST" });
  await ctx.close();
});

test("a new device reconnects to every host used with the branchr account", async ({ browser }) => {
  const HOME = "http://localhost:8080";
  const id = `7${Date.now()}`;
  await fetch("http://localhost:8071/next-user", {
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
  await expect(one.getByTestId("instance-header")).toHaveCount(2);

  // A new device: sign in to one host, and the other comes along.
  const two = await (await browser.newContext()).newPage();
  await two.goto("/#/login");
  await two.getByLabel("Server", { exact: true }).fill(FED);
  await two.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(two.getByTestId("instance-header")).toHaveCount(2);
  expect((await sessions(two)).map((s) => s.url).sort()).toEqual([FED, HOME].sort());
  // Still on the host it signed in to.
  expect(two.url()).toContain("/localhost-8081");

  // Logging out of a host on purpose forgets it for the account.
  two.on("dialog", (d) => void d.accept());
  await two.locator('[data-testid="instance-header"][data-instance="localhost-8080"]').click({ button: "right" });
  await two.getByRole("menuitem", { name: /^Log Out of localhost:8080/ }).click();
  await expect(two.getByTestId("instance-header")).toHaveCount(0);
  const three = await (await browser.newContext()).newPage();
  await three.goto("/#/login");
  await three.getByLabel("Server", { exact: true }).fill(FED);
  await three.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(three.getByRole("heading", { name: "No servers yet" })).toBeVisible();
  await three.waitForTimeout(1500);
  expect((await sessions(three)).map((s) => s.url)).toEqual([FED]);

  await fetch("http://localhost:8071/next-user", { method: "POST" });
});
