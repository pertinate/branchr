// Relays: claiming, linking only your own, ports and passes; then, with BRANCHR_BIN_DIR set
// (`cargo build -p api -p sfu -p relay`), a real relay carrying a real hub.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";

import { skip, start, until } from "./harness.mjs";

const FP = "ab".repeat(32);

describe("relays", { skip }, () => {
  let s, alice, bob;
  const call = (method, p, { token, body } = {}) =>
    fetch(`${s.url}${p}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const ok = async (...args) => {
    const r = await call(...args);
    assert.equal(r.ok, true, `${args[0]} ${args[1]}: ${r.status} ${await r.clone().text()}`);
    return r.status === 204 || r.headers.get("content-length") === "0" ? null : r.json();
  };
  const signIn = async (user) => (await s.exchange(await s.authorize(user))).json();
  const about = (over = {}) => ({ quic: "relay.example.com:7443", fp: FP, web: "https://relay.example.com", publicIp: "203.0.113.5", udpStart: 53000, udpEnd: 53009, ...over });
  const beat = (r, over) => ok("POST", `/relays/${r.relayId}/heartbeat`, { token: r.secret, body: about(over) });
  /** A hub or relay, claimed by `who`. */
  async function made(kind, who) {
    const r = await ok("POST", kind === "hub" ? "/instances" : "/relays", { body: { name: kind, publicUrl: "" } });
    await ok("POST", kind === "hub" ? "/claims" : "/relays/claims", { token: who.access_token, body: { code: r.claimCode } });
    return r;
  }
  const link = (hub, relay, who) => call("PUT", `/instances/${hub.instanceId}/relay`, { token: who.access_token, body: { relayId: relay?.relayId ?? null } });
  const pass = (hub, ports) => call("POST", `/instances/${hub.instanceId}/relay-pass`, { token: hub.secret, body: { ports } });

  before(async () => {
    s = await start(18096);
    alice = await signIn({ id: "1", username: "alice", global_name: "Alice" });
    bob = await signIn({ id: "2", username: "bob", global_name: "Bob" });
  });
  after(() => s?.stop());
  // Each test claims plenty of things from one address.
  beforeEach(() => s.db.query("DELETE FROM rate_limits"));

  it("links only a hub and relay with the same owner", async () => {
    const hub = await made("hub", alice);
    const mine = await made("relay", alice);
    const theirs = await made("relay", bob);
    assert.equal((await link(hub, theirs, alice)).status, 404, "someone else's relay");
    assert.equal((await link(hub, theirs, bob)).status, 404, "someone else's hub");
    assert.equal((await link(hub, mine, alice)).status, 204);
    assert.deepEqual((await ok("GET", "/me/relays", { token: alice.access_token })).map((r) => r.relayId), [mine.relayId]);
    const none = await pass(hub, 2);
    assert.equal(none.status, 404, "the relay hasn't reported where it is");
    assert.equal((await none.json()).error, "no_relay");
  });

  it("assigns ports that never overlap, in passes naming one relay", async () => {
    const relay = await made("relay", alice);
    const [a, b, c] = [await made("hub", alice), await made("hub", alice), await made("hub", alice)];
    await beat(relay);
    for (const h of [a, b, c]) assert.equal((await link(h, relay, alice)).status, 204);
    const [pa, pb] = await Promise.all([pass(a, 4), pass(b, 4)].map(async (r) => (await r).json()));
    assert.deepEqual([pa.udpBase, pb.udpBase].sort(), [53000, 53004]);
    const full = await pass(c, 4);
    assert.equal(full.status, 409);
    assert.equal((await full.json()).error, "no_ports");
    assert.equal((await (await pass(c, 2)).json()).udpBase, 53008);
    assert.equal((await (await pass(a, 4)).json()).udpBase, pa.udpBase, "ports stay put");
    const jwks = createLocalJWKSet(await (await fetch(`${s.url}/.well-known/jwks.json`)).json());
    const { payload } = await jwtVerify(pa.token, jwks, { issuer: s.url, audience: relay.relayId });
    assert.deepEqual([payload.sub, payload.owner, payload.udpBase, payload.udpPorts], [a.instanceId, alice.account.id, pa.udpBase, 4]);
    assert.deepEqual(pa.relay, { id: relay.relayId, quic: "relay.example.com:7443", fp: FP, web: "https://relay.example.com", publicIp: "203.0.113.5" });
    assert.equal((await beat(relay)).hubs.length, 3);
    // Unlinking, transferring and releasing all take a hub off the relay.
    assert.equal((await link(a, null, alice)).status, 204);
    await ok("POST", `/instances/${b.instanceId}/transfer`, { token: alice.access_token, body: { handle: "bob" } });
    await ok("DELETE", `/instances/${c.instanceId}/claim`, { token: alice.access_token });
    assert.deepEqual((await beat(relay)).hubs, []);
    for (const h of [a, b, c]) assert.equal((await pass(h, 2)).status, 404);
  });

  it("releasing a relay unlinks its hubs, and bad reports are refused", async () => {
    const relay = await made("relay", alice);
    const hub = await made("hub", alice);
    for (const bad of [{ quic: "nope" }, { fp: "12" }, { web: "ftp://x" }, { publicIp: "x" }, { udpStart: 80 }, { udpEnd: 1 }]) {
      const r = await call("POST", `/relays/${relay.relayId}/heartbeat`, { token: relay.secret, body: about(bad) });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await call("POST", `/relays/${relay.relayId}/heartbeat`, { token: hub.secret, body: about() })).status, 401);
    await beat(relay);
    await link(hub, relay, alice);
    await ok("POST", `/instances/${hub.instanceId}/relay-pass`, { token: hub.secret, body: { ports: 1 } });
    assert.equal((await call("DELETE", `/relays/${relay.relayId}/claim`, { token: bob.access_token })).status, 404);
    await ok("DELETE", `/relays/${relay.relayId}/claim`, { token: alice.access_token });
    assert.deepEqual(await beat(relay), { ownerId: null, hubs: [] });
    assert.equal((await pass(hub, 1)).status, 404);
  });

  const dir = process.env.BRANCHR_BIN_DIR;
  it("carries a real hub and its voice server, until unlinked", { skip: !dir && "needs BRANCHR_BIN_DIR", timeout: 90_000 }, async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "branchr-relay-"));
    const children = [];
    const run = (bin, args, env) =>
      children.push(spawn(path.resolve(dir, bin), args, { cwd: tmp, stdio: ["ignore", process.env.BRANCHR_LOG ? "inherit" : "ignore", "inherit"], env: { PATH: process.env.PATH, RUST_LOG: process.env.BRANCHR_LOG || "warn", ...env } }));
    try {
      run("branchr-relay", ["serve"], { RELAY_MANAGED: "1", RELAY_ID_URL: s.url, RELAY_NAME: "Real relay", RELAY_DIR: `${tmp}/relay`, RELAY_QUIC: "127.0.0.1:18443",
        RELAY_HTTP: "127.0.0.1:18444", RELAY_PUBLIC: "127.0.0.1:18443", RELAY_WEB: "http://127.0.0.1:18444", RELAY_PUBLIC_IP: "127.0.0.1",
        RELAY_UDP_START: "52500", RELAY_UDP_END: "52503", RELAY_HEARTBEAT_SECS: "1" });
      run("sfu", [], { SFU_BIND: "127.0.0.1:18445", SFU_UDP_PORT: "52510", SFU_WORKERS: "2", SFU_PUBLIC_IP: "relay", VOICE_SECRET: "test-voice" });
      run("api", [], { DATABASE_URL: `sqlite://${tmp}/hub.db`, UPLOAD_DIR: `${tmp}/up`, API_BIND: "127.0.0.1:18446", SFU_URLS: "ws://127.0.0.1:18445/ws",
        VOICE_SECRET: "test-voice", AUTH_MODE: "both", BRANCHR_ID_URL: s.url, INSTANCE_NAME: "Relayed hub", CLAIM_FILE: `${tmp}/hub-claim.txt`,
        RELAY: "1", TRUST_PROXY: "1", BRANCHR_POLL_SECS: "1", RELAY_POLL_SECS: "1" });
      const read = (f) => readFileSync(`${tmp}/${f}`, "utf8").trim();
      await until(async () => existsSync(`${tmp}/relay/claim-code.txt`) && existsSync(`${tmp}/hub-claim.txt`), "they didn't register");
      await ok("POST", "/relays/claims", { token: alice.access_token, body: { code: read("relay/claim-code.txt") } });
      const { instanceId } = await ok("POST", "/claims", { token: alice.access_token, body: { code: read("hub-claim.txt") } });
      const sfu = async () => (await fetch("http://127.0.0.1:18445/status")).json();
      assert.deepEqual([(await sfu()).publicIp, (await sfu()).lanIp], ["192.0.2.1", null], "nothing real before a relay");
      const relay = (await ok("GET", "/me/relays", { token: alice.access_token })).find((r) => r.name === "Real relay");
      const hubUrl = `http://127.0.0.1:18444/h/${instanceId}`;
      assert.equal((await fetch(`${hubUrl}/api/health`)).status, 502);
      await ok("PUT", `/instances/${instanceId}/relay`, { token: alice.access_token, body: { relayId: relay.relayId } });
      await until(async () => (await fetch(`${hubUrl}/api/health`)).status === 200, "the hub never came through the relay");
      await until(async () => (await sfu()).via === "relay", "the voice server wasn't told");
      const told = await sfu();
      assert.deepEqual([told.publicIp, told.ports, told.lanIp], ["127.0.0.1", [52500, 52501], null]);
      // Visitors can't move the voice server, even knowing the secret.
      const forged = await fetch(`${hubUrl}/sfu/relay`, { method: "POST", headers: { authorization: "Bearer test-voice", "content-type": "application/json" }, body: JSON.stringify({ publicIp: "198.51.100.1", publicPort: 1 }) });
      assert.equal(forged.status, 401);
      // A visitor signs in through the relay with their branchr account.
      const { token } = await ok("POST", `/instances/${instanceId}/token`, { token: bob.access_token });
      const login = await fetch(`${hubUrl}/api/auth/federated`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      assert.equal(login.status, 200);
      await ok("PUT", `/instances/${instanceId}/relay`, { token: alice.access_token, body: { relayId: null } });
      await until(async () => (await fetch(`${hubUrl}/api/health`)).status === 502, "unlinking didn't cut it off");
      // And linking again brings it back.
      await ok("PUT", `/instances/${instanceId}/relay`, { token: alice.access_token, body: { relayId: relay.relayId } });
      await until(async () => (await fetch(`${hubUrl}/api/health`)).status === 200, "it didn't come back", 300);
    } finally {
      for (const c of children) c.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
