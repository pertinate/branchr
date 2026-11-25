// Sign-in end to end: the built site (`pnpm build` first), a real Postgres
// (TEST_DATABASE_URL; a throwaway database is made in it) and a stand-in Discord.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";

const base = process.env.TEST_DATABASE_URL;
const site = fileURLToPath(new URL("..", import.meta.url));
const PORT = 18090;
const MOCK = 18091;
const URL_ = `http://localhost:${PORT}`;
const REDIRECT = `${URL_}/account`;

describe("sign-in", { skip: !base && "needs TEST_DATABASE_URL (Postgres)" }, () => {
  const name = `branchr_site_${process.pid}`;
  const children = [];
  let admin, db;

  before(async () => {
    admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(base);
    url.pathname = `/${name}`;
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      DATABASE_URL_UNPOOLED: "",
      PUBLIC_URL: URL_,
      ALLOWED_REDIRECTS: "",
      DISCORD_CLIENT_ID: "test",
      DISCORD_CLIENT_SECRET: "test",
      DISCORD_API: `http://127.0.0.1:${MOCK}/api`,
      DISCORD_AUTHORIZE: `http://127.0.0.1:${MOCK}/oauth2/authorize`,
      DEFAULT_HUB: "https://hub.example.com",
    };
    for (let i = 0; i < 2; i++) assert.equal(spawnSync("node", ["scripts/migrate.mjs"], { cwd: site, env, stdio: "inherit" }).status, 0);
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    children.push(spawn("node", ["../../tests/e2e/mock-discord.mjs"], { cwd: site, env: { ...env, PORT: String(MOCK) } }));
    children.push(spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], { cwd: site, env, stdio: ["ignore", "ignore", "inherit"] }));
    for (let i = 0; ; i++) {
      const ok = await Promise.all([fetch(`${URL_}/health`), fetch(`http://127.0.0.1:${MOCK}/health`)]).then((r) => r.every((x) => x.ok), () => false);
      if (ok) break;
      assert.ok(i < 150, "servers didn't start");
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  after(async () => {
    for (const c of children) c.kill();
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  const post = (path, body) => fetch(`${URL_}${path}`, { method: "POST", body: new URLSearchParams(body) });
  const hop = async (url) => {
    const r = await fetch(url, { redirect: "manual" });
    assert.equal(r.status >= 300 && r.status < 400, true, `expected a redirect from ${url}, got ${r.status}`);
    return new URL(r.headers.get("location"), url);
  };
  /** Through Discord and back: the code our client receives. */
  async function authorize(redirectUri = REDIRECT) {
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ redirect_uri: redirectUri, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "xyz" });
    const back = await hop(await hop(await hop(`${URL_}/authorize?${q}`)));
    assert.equal(back.searchParams.get("state"), "xyz");
    return { code: back.searchParams.get("code"), verifier, back };
  }
  const exchange = ({ code, verifier }, over = {}) => post("/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, ...over });
  const refresh = (token) => post("/token", { grant_type: "refresh_token", refresh_token: token });

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
