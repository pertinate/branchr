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
