// Sign-in end to end (see harness.mjs).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";

import { skip, start } from "./harness.mjs";

describe("sign-in", { skip }, () => {
  let s, URL_, db, post, hop, authorize, exchange, refresh;
  before(async () => {
    s = await start(18090);
    ({ url: URL_, db, post, hop, authorize, exchange, refresh } = s);
  });
  after(() => s?.stop());

  it("signs in, and hubs can verify the token from the JWKS", async () => {
    const t = await (await exchange(await authorize())).json();
    assert.equal(t.account.displayName, "E2E Nelly");
    const me = await fetch(`${URL_}/me`, { headers: { authorization: `Bearer ${t.access_token}` } });
    assert.deepEqual(await me.json(), t.account);
    const jwks = await (await fetch(`${URL_}/.well-known/jwks.json`)).json();
    const { payload } = await jwtVerify(t.access_token, createLocalJWKSet(jwks), { issuer: URL_, audience: "branchr-id" });
    assert.equal(payload.sub, t.account.id);
    // A second sign-in is the same account.
    const again = await (await exchange(await authorize())).json();
    assert.equal(again.account.id, t.account.id);
    assert.equal((await db.query("SELECT handle FROM accounts")).rows.map((r) => r.handle).join(), "e2e_nelly");
  });

  it("refuses bad requests", async () => {
    const q = new URLSearchParams({ redirect_uri: "https://evil.example/", code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s" });
    assert.equal((await fetch(`${URL_}/authorize?${q}`, { redirect: "manual" })).status, 400);
    const a = await authorize();
    assert.equal((await exchange(a, { code_verifier: "b".repeat(43) })).status, 400);
    assert.equal((await exchange(a)).status, 400, "a code works once, even after a failed try");
    assert.equal((await fetch(`${URL_}/me`)).status, 401);
    assert.equal((await fetch(`${URL_}/me`, { headers: { authorization: "Bearer nonsense" } })).status, 401);
    assert.equal((await post("/token", { grant_type: "password" })).status, 400);
  });

  it("rotates refresh tokens, and revokes a sign-in on late reuse", async () => {
    const first = (await (await exchange(await authorize())).json()).refresh_token;
    const second = (await (await refresh(first)).json()).refresh_token;
    assert.notEqual(second, first);
    assert.equal((await refresh(first)).status, 200, "two tabs at once are allowed");
    await db.query("UPDATE refresh_tokens SET rotated_at = now() - interval '5 minutes' WHERE rotated");
    assert.equal((await refresh(first)).status, 400);
    assert.equal((await refresh(second)).status, 400, "the whole sign-in is gone");
  });

  it("signs out", async () => {
    const t = (await (await exchange(await authorize())).json()).refresh_token;
    assert.equal((await post("/logout", { refresh_token: t })).status, 200);
    assert.equal((await refresh(t)).status, 400);
  });

  it("serves the pages and the web app", async () => {
    for (const p of ["/", "/features", "/performance", "/how-it-works", "/self-host", "/account", "/app/"]) {
      const r = await fetch(`${URL_}${p}`, { redirect: "manual" });
      assert.equal(r.status, 200, p);
    }
    assert.equal((await hop(`${URL_}/app`)).pathname, "/app/");
    const html = await (await fetch(`${URL_}/app/`)).text();
    const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.equal((await fetch(`${URL_}/app/${script}`)).status, 200);
    assert.match(await (await fetch(`${URL_}/app/config.js`)).text(), /"defaultHub":"https:\/\/hub\.example\.com"/);
  });

  it("limits how often one address may ask", async () => {
    let status = 0;
    for (let i = 0; i < 70 && status !== 429; i++) status = (await post("/token", { grant_type: "password" })).status;
    assert.equal(status, 429);
  });
});
