import { type Page, expect, test } from "@playwright/test";

import { createServer, joinServer, register, session } from "./helpers";

/** Calls this page's host as its signed-in user. */
async function call(page: Page, method: string, path: string, body?: unknown) {
  const s = await session(page);
  return page.evaluate(
    async ([url, token, method, path, body]) => {
      const r = await fetch(`${url}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null };
    },
    [s.url, s.token, method, path, body] as const,
  );
}

test("threads: start one from a message, talk in it, and private channels keep theirs private", async ({ browser }) => {
  const alice = await register(browser, "thr_a");
  const code = await createServer(alice, "Threads");
  const bob = await register(browser, "thr_b");
  await joinServer(bob, code);

  await alice.getByPlaceholder("Message #general").fill("let's plan the trip");
  await alice.getByPlaceholder("Message #general").press("Enter");
  await alice.getByText("let's plan the trip").click({ button: "right" });
  await alice.getByRole("menuitem", { name: "Create Thread" }).click();
  await alice.getByLabel("Thread name").fill("Trip");
  await alice.getByRole("button", { name: "Create Thread" }).click();
  await expect(alice.getByPlaceholder("Message #Trip")).toBeVisible();
  await expect(alice.locator("header").getByRole("link", { name: "general" })).toBeVisible();
  await alice.getByPlaceholder("Message #Trip").fill("day one: the coast");
  await alice.getByPlaceholder("Message #Trip").press("Enter");

  // Bob: under #general in the list, and linked from the message it started from.
  await expect(bob.locator("a[data-thread]").filter({ hasText: "Trip" })).toBeVisible();
  await bob.getByTestId("thread-link").filter({ hasText: "Trip" }).click();
  await expect(bob.getByText("day one: the coast")).toBeVisible();
  await bob.getByPlaceholder("Message #Trip").fill("sounds good");
  await bob.getByPlaceholder("Message #Trip").press("Enter");
  await expect(alice.getByText("sounds good")).toBeVisible();
  // The thread's messages stay out of the channel itself.
  await alice.locator("header").getByRole("link", { name: "general" }).click();
  await expect(alice.getByText("let's plan the trip")).toBeVisible();
  await expect(alice.getByText("sounds good")).toHaveCount(0);

  // A thread in a channel Bob can't see is invisible to him too.
  const gid = alice.url().split("/").slice(-2)[0];
  const staff = await call(alice, "POST", `/guilds/${gid}/channels`, { name: "staff", kind: "text" });
  expect(staff.status).toBe(200);
  expect((await call(alice, "PUT", `/channels/${staff.body.id}/permissions/${gid}`, { kind: "role", allow: 0, deny: 1 })).status).toBe(200);
  const secret = await call(alice, "POST", `/channels/${staff.body.id}/threads`, { name: "secret plans" });
  expect(secret.status).toBe(200);
  expect((await call(bob, "GET", `/channels/${secret.body.id}/messages`)).status).toBe(404);
  expect((await call(bob, "POST", `/channels/${secret.body.id}/messages`, { content: "hi" })).status).toBe(404);
  await expect(bob.getByText("secret plans")).toHaveCount(0);
  await expect(alice.locator("a[data-thread]").filter({ hasText: "secret plans" })).toBeVisible();
});
