// Hubs: registering, claiming and passes; then, with BRANCHR_BIN_DIR set to built programs
// (`cargo build -p api`), the real thing signing someone in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";

import { skip, start, until } from "./harness.mjs";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

describe("hubs", { skip }, () => {
  let s, alice, bob;
  const call = (method, p, { token, body } = {}) =>
    fetch(`${s.url}${p}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const signIn = async (user) => (await (await s.exchange(await s.authorize(user))).json());
  const register = async (name = "Home") => (await call("POST", "/instances", { body: { name, publicUrl: "" } })).json();

  before(async () => {
    // Deleting a hub behind the site's back is only noticed once its cached check-ins lapse.
    s = await start(18092, { CHECKIN_CACHE_SECS: "2" });
    alice = await signIn({ id: "1", username: "alice", global_name: "Alice" });
    bob = await signIn({ id: "2", username: "bob", global_name: "Bob" });
  });
  after(() => s?.stop());

  it("registers, is claimed once, and gives passes meant for that hub", async () => {
    const hub = await register();
    const status = async () => (await call("GET", `/instances/${hub.instanceId}`, { token: hub.secret })).json();
    assert.deepEqual(await status(), { claimed: false, ownerId: null });
    assert.equal((await call("POST", "/claims", { body: { code: hub.claimCode } })).status, 401);
    const typed = hub.claimCode.toLowerCase().replace("-", " ");
    const claimed = await call("POST", "/claims", { token: alice.access_token, body: { code: typed } });
    assert.equal((await claimed.json()).instanceId, hub.instanceId);
    assert.equal((await call("POST", "/claims", { token: bob.access_token, body: { code: hub.claimCode } })).status, 400);
    assert.deepEqual(await status(), { claimed: true, ownerId: alice.account.id });
    assert.equal((await call("POST", `/instances/${hub.instanceId}/claim-code`, { token: hub.secret })).status, 400);

    const { token } = await (await call("POST", `/instances/${hub.instanceId}/token`, { token: bob.access_token })).json();
    const jwks = createLocalJWKSet(await (await fetch(`${s.url}/.well-known/jwks.json`)).json());
    const { payload } = await jwtVerify(token, jwks, { issuer: s.url, audience: hub.instanceId });
    assert.equal(payload.sub, bob.account.id);
    assert.equal(payload.username, "bob");
    // A hub's pass isn't a sign-in to branchr.
    assert.equal((await call("GET", "/me", { token })).status, 401);
  });

  it("lets only the hub itself and its owner act on it", async () => {
    const hub = await register();
    const other = await register();
    await call("POST", "/claims", { token: alice.access_token, body: { code: hub.claimCode } });
    assert.equal((await call("GET", `/instances/${hub.instanceId}`, { token: other.secret })).status, 401);
    assert.equal((await call("GET", `/instances/${UNKNOWN}`, { token: hub.secret })).status, 404);
    assert.equal((await call("GET", "/instances/nonsense", { token: hub.secret })).status, 404);
    assert.equal((await call("DELETE", `/instances/${hub.instanceId}/claim`, { token: bob.access_token })).status, 404);
    assert.equal((await call("POST", `/instances/${hub.instanceId}/transfer`, { token: bob.access_token, body: { handle: "alice" } })).status, 404);
    assert.equal((await call("POST", `/instances/${hub.instanceId}/transfer`, { token: alice.access_token, body: { handle: "@bob" } })).status, 204);
    const owned = await (await call("GET", "/me/owned", { token: bob.access_token })).json();
    assert.deepEqual(owned.map((h) => h.instanceId), [hub.instanceId]);
    assert.equal(typeof owned[0].lastSeen === "number" || owned[0].lastSeen === null, true);
    assert.equal((await call("DELETE", `/instances/${hub.instanceId}/claim`, { token: bob.access_token })).status, 204);
    assert.equal((await call("POST", `/instances/${hub.instanceId}/claim-code`, { token: hub.secret })).status, 200);
  });

  it("sets up a hub from a one-time code", async () => {
    const { code } = await (await call("POST", "/setup-codes", { token: alice.access_token, body: { name: "New" } })).json();
    const check = async (token) => call("GET", `/setup-codes/${code}`, { token });
    assert.equal((await (await check(alice.access_token)).json()).instanceId, null);
    assert.equal((await check(bob.access_token)).status, 404);
    const redeemed = await (await call("POST", "/instances/setup", { body: { code: code.toLowerCase(), publicUrl: "https://new.example.com" } })).json();
    assert.equal((await call("POST", "/instances/setup", { body: { code, publicUrl: "" } })).status, 400);
    assert.equal((await (await check(alice.access_token)).json()).instanceId, redeemed.instanceId);
    const st = await (await call("GET", `/instances/${redeemed.instanceId}`, { token: redeemed.secret })).json();
    assert.equal(st.ownerId, alice.account.id);
  });

  it("remembers the hubs an account uses", async () => {
    const hosts = async () => (await call("GET", "/me/instances", { token: alice.access_token })).json();
    for (const url of ["https://Chat.Example.com/app/#/x", "https://chat.example.com/"]) {
      assert.equal((await call("PUT", "/me/instances", { token: alice.access_token, body: { url } })).status, 200);
    }
    assert.deepEqual(await hosts(), [{ url: "https://chat.example.com" }]);
    assert.equal((await call("PUT", "/me/instances", { token: alice.access_token, body: { url: "ftp://x" } })).status, 400);
    await call("DELETE", "/me/instances", { token: alice.access_token, body: { url: "https://chat.example.com" } });
    assert.deepEqual(await hosts(), []);
    assert.equal((await fetch(`${s.url}/me/instances`, { method: "OPTIONS" })).headers.get("access-control-allow-methods")?.includes("PUT"), true);
  });

  const bin = process.env.BRANCHR_BIN_DIR && path.join(process.env.BRANCHR_BIN_DIR, "api");
  it("signs people in to a real hub, its owner even with sign-ups closed", { skip: !bin && "needs BRANCHR_BIN_DIR" }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "branchr-hub-"));
    const hubUrl = "http://127.0.0.1:18094";
    const claimFile = path.join(dir, "claim.txt");
    const hub = spawn(path.resolve(bin), [], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
      env: { PATH: process.env.PATH, DATABASE_URL: `sqlite://${dir}/hub.db`, UPLOAD_DIR: `${dir}/up`, API_BIND: "127.0.0.1:18094", VOICE_SECRET: "test",
        AUTH_MODE: "both", BRANCHR_ID_URL: s.url, INSTANCE_NAME: "Real hub", CLAIM_FILE: claimFile, BRANCHR_POLL_SECS: "1", OPEN_REGISTRATION: "false" },
    });
    try {
      const info = async () => (await fetch(`${hubUrl}/api/instance`)).json();
      await until(async () => (await info()).instanceId && existsSync(claimFile), "the hub didn't register");
      const first = (await info()).instanceId;
      const claim = () => call("POST", "/claims", { token: alice.access_token, body: { code: readFileSync(claimFile, "utf8") } });
      assert.equal((await claim()).status, 200);
      await until(async () => (await info()).claimed, "the hub didn't notice its claim");
      const signInAs = async (who) => {
        const { token } = await (await call("POST", `/instances/${first}/token`, { token: who.access_token })).json();
        return fetch(`${hubUrl}/api/auth/federated`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      };
      assert.equal((await signInAs(bob)).status, 403, "sign-ups are closed");
      const login = await signInAs(alice);
      assert.equal(login.status, 200);
      assert.equal((await login.json()).user.username, "alice");
    } finally {
      hub.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is forgotten and registers again", { skip: !bin && "needs BRANCHR_BIN_DIR" }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "branchr-hub-"));
    const claimFile = path.join(dir, "claim.txt");
    const env = { PATH: process.env.PATH, DATABASE_URL: `sqlite://${dir}/hub.db`, UPLOAD_DIR: `${dir}/up`, API_BIND: "127.0.0.1:18095", VOICE_SECRET: "test",
      AUTH_MODE: "both", BRANCHR_ID_URL: s.url, INSTANCE_NAME: "Moved hub", CLAIM_FILE: claimFile, BRANCHR_POLL_SECS: "1" };
    let hub;
    const run = () => spawn(path.resolve(bin), [], { cwd: dir, stdio: ["ignore", "ignore", "inherit"], env });
    const id = async () => (await (await fetch("http://127.0.0.1:18095/api/instance")).json()).instanceId;
    try {
      hub = run();
      await until(async () => !!(await id()), "the hub didn't register");
      const first = await id();
      await s.db.query("DELETE FROM hubs WHERE id = $1", [first]);
      await until(async () => { const now = await id(); return !!now && now !== first; }, "the hub didn't register again");
    } finally {
      hub?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
