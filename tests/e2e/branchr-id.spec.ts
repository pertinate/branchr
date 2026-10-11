import { expect, test } from "@playwright/test";

import { createServer, register } from "./helpers";

test.skip(!process.env.TEST_DATABASE_URL, "branchr ID needs TEST_DATABASE_URL (Postgres)");

test("branchr account: sign in with Discord, survive a reload, sign out", async ({ browser }) => {
  const page = await register(browser, "bid");
  await createServer(page, "Accounts");
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
  const session = () => page.evaluate(() => JSON.parse(localStorage.getItem("auth") ?? "{}").state);
  const first = await session();
  expect(first.serverUrl).toBe(FED);
  expect(first.user.displayName).toBe("E2E Nelly");
  expect(first.user.username).toMatch(/^e2e_nelly\d*$/);

  // The owner claims the server with the code it wrote out, from User Settings.
  const code = readFileSync(claimFile, "utf8").trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await createServer(page, "Federated home");
  await page.getByRole("button", { name: "User Settings" }).click();
  await page.getByLabel(/Claim a server you host/).fill(code.toLowerCase());
  await page.getByRole("button", { name: "Claim" }).click();
  await expect(page.getByText("You now own e2e federated")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await (await fetch(`${FED}/api/instance`)).json()).claimed, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => existsSync(claimFile)).toBe(false);

  // Log out of the server and back in: same user, no second Discord trip (already signed in).
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem("auth") ?? "{}");
    a.state.token = null;
    a.state.user = null;
    localStorage.setItem("auth", JSON.stringify(a));
  });
  await page.goto("/#/login");
  await page.reload();
  await page.getByLabel("Server", { exact: true }).fill(FED);
  await page.getByRole("button", { name: "Sign in with Discord" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to #general!" })).toBeVisible();
  expect((await session()).user.id).toBe(first.user.id);

  // A pass is for one server only: the local-only server refuses branchr logins.
  const local = await (await fetch("http://localhost:8080/api/instance")).json();
  expect(local.authMode).toBe("local");
  await ctx.close();
});
