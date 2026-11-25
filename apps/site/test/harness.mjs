// The built site (`pnpm build` first) against a real Postgres (TEST_DATABASE_URL; a
// throwaway database is made in it) and a stand-in Discord.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const base = process.env.TEST_DATABASE_URL;
export const skip = !base && "needs TEST_DATABASE_URL (Postgres)";
const site = fileURLToPath(new URL("..", import.meta.url));

/** Starts everything on `port` (the Discord stand-in on the next one). */
export async function start(port) {
  const url_ = `http://localhost:${port}`;
  const mock = port + 1;
  const name = `branchr_site_${process.pid}_${port}`;
  const children = [];
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${name}`;
  const env = {
    ...process.env,
    DATABASE_URL: dbUrl.toString(),
    DATABASE_URL_UNPOOLED: "",
    PUBLIC_URL: url_,
    ALLOWED_REDIRECTS: "",
    DISCORD_CLIENT_ID: "test",
    DISCORD_CLIENT_SECRET: "test",
    DISCORD_API: `http://127.0.0.1:${mock}/api`,
    DISCORD_AUTHORIZE: `http://127.0.0.1:${mock}/oauth2/authorize`,
    DEFAULT_HUB: "https://hub.example.com",
  };
  // Twice: applying again changes nothing.
  for (let i = 0; i < 2; i++) assert.equal(spawnSync("node", ["scripts/migrate.mjs"], { cwd: site, env, stdio: "inherit" }).status, 0);
  const db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  children.push(spawn("node", ["../../tests/e2e/mock-discord.mjs"], { cwd: site, env: { ...env, PORT: String(mock) } }));
  children.push(spawn("node_modules/.bin/next", ["start", "-p", String(port)], { cwd: site, env, stdio: ["ignore", "ignore", "inherit"] }));
  await until(async () => (await fetch(`${url_}/health`)).ok && (await fetch(`http://127.0.0.1:${mock}/health`)).ok, "servers didn't start");

  const post = (path, body) => fetch(`${url_}${path}`, { method: "POST", body: new URLSearchParams(body) });
  const hop = async (url) => {
    const r = await fetch(url, { redirect: "manual" });
    assert.equal(r.status >= 300 && r.status < 400, true, `expected a redirect from ${url}, got ${r.status}`);
    return new URL(r.headers.get("location"), url);
  };
  const redirectUri = `${url_}/account`;
  /** Through Discord and back: the code our client receives. */
  async function authorize(user) {
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ redirect_uri: redirectUri, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "xyz" });
    const discord = await hop(`${url_}/authorize?${q}`);
    const cookie = user ? `mock_discord_user=${encodeURIComponent(JSON.stringify(user))}` : "";
    const r = await fetch(discord, { redirect: "manual", headers: { cookie } });
    const back = await hop(r.headers.get("location"));
    assert.equal(back.searchParams.get("state"), "xyz");
    return { code: back.searchParams.get("code"), verifier, back };
  }
  const exchange = ({ code, verifier }, over = {}) => post("/token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, ...over });
  const refresh = (token) => post("/token", { grant_type: "refresh_token", refresh_token: token });

  async function stop() {
    for (const c of children) c.kill();
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
  return { url: url_, env, db, post, hop, authorize, exchange, refresh, stop };
}

export async function until(check, message, tries = 150) {
  for (let i = 0; ; i++) {
    if (await check().catch(() => false)) return;
    assert.ok(i < tries, message);
    await new Promise((r) => setTimeout(r, 200));
  }
}
