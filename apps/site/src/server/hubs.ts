//! Self-hosted hubs that accept branchr accounts.
//!
//! 1. The hub registers: `POST /instances` → id, secret and a claim code it shows its owner.
//!    (Or it redeems a setup code from the website, and is theirs from the start.)
//! 2. The owner, signed in, enters the code: `POST /claims` makes them the hub's owner.
//! 3. To open a hub, a signed-in client asks for a pass: `POST /instances/{id}/token`, a
//!    short-lived JWT whose audience is that hub. The hub verifies it with our JWKS.
//!
//! The paths say "instances", the protocol's name for hubs.
import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import { claimCode, hash, normalizeClaimCode, setupCode } from "./codes";
import { query, transaction } from "./db";
import { OAuthError, bad, body, empty, json, notFound, text } from "./http";
import { sign } from "./keys";
import { authed } from "./oauth";
import { rateLimit } from "./ratelimit";

/** How long a hub's pass for a user lasts; the client asks for a new one each login. */
const PASS_TTL_SECS = 10 * 60;
const CODE_TTL_HOURS = 24;
const MAX_OPEN_SETUP_CODES = 10;

type Params = { id: string };

/** An id from a request; anything else names nothing. */
export function uuid(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound();
  return id.toLowerCase();
}

const hubId = (p: Params) => uuid(p.id);

/** A hub that changes hands leaves its old owner's relay. */
const UNLINK = "relay_id = NULL, relay_port_base = NULL, relay_port_count = NULL";

function hubName(v: unknown): string {
  const name = text(v).trim();
  if (!name || [...name].length > 100) throw bad("invalid_request", "a hub's name is 1-100 characters");
  return name;
}

/** The address a hub says it's at: empty, or an http(s) URL. */
function publicUrl(v: unknown): string {
  const url = text(v);
  if (url && (url.length > 300 || !/^https?:$/.test(URL.parse(url)?.protocol ?? ""))) throw bad("invalid_request", "publicUrl must be a URL");
  return url;
}

const newSecret = () => randomBytes(32).toString("base64url");

export async function register(req: Request): Promise<Response> {
  await rateLimit(req, "register", 10);
  const b = await body(req);
  const id = randomUUID();
  const secret = newSecret();
  const code = claimCode();
  await query(
    `INSERT INTO hubs (id, secret_hash, name, public_url, claim_code_hash, claim_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [id, hash(secret), hubName(b.name), publicUrl(b.publicUrl), hash(code), CODE_TTL_HOURS],
  );
  return json({ instanceId: id, secret, claimCode: code });
}

/** The hub behind `Authorization: Bearer <hub secret>`. A hub we don't know is "not found",
 *  which tells it to register again. */
export async function hubAuth(req: Request, id: string): Promise<{ ownerId: string | null }> {
  const secret = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const [hub] = await query<{ ok: boolean; ownerId: string | null }>(
    `SELECT secret_hash = $2 AS ok, owner_id AS "ownerId" FROM hubs WHERE id = $1`,
    [id, hash(secret ?? "")],
  );
  if (!hub) throw notFound();
  if (!secret || !hub.ok) throw new OAuthError(401, "invalid_token", "unauthorized");
  // At most once a minute: it's a heartbeat, not a log.
  await query("UPDATE hubs SET last_seen_at = now() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')", [id]);
  return hub;
}

/** For the hub itself: has someone claimed it yet? */
export async function status(req: Request, p: Params): Promise<Response> {
  const { ownerId } = await hubAuth(req, hubId(p));
  return json({ claimed: ownerId !== null, ownerId });
}

/** For the hub itself: a fresh claim code (the last one expired). */
export async function newClaimCode(req: Request, p: Params): Promise<Response> {
  const id = hubId(p);
  await rateLimit(req, "claim-code");
  await hubAuth(req, id);
  const code = claimCode();
  const rows = await query(
    `UPDATE hubs SET claim_code_hash = $1, claim_expires_at = now() + make_interval(hours => $2)
     WHERE id = $3 AND owner_id IS NULL RETURNING id`,
    [hash(code), CODE_TTL_HOURS, id],
  );
  if (!rows.length) throw bad("invalid_request", "this hub is already claimed");
  return json({ claimCode: code });
}

/** A signed-in person claims a hub with the code it showed them. */
export async function claim(req: Request): Promise<Response> {
  await rateLimit(req, "claim", 10);
  const account = await authed(req);
  const b = await body(req);
  const [hub] = await query(
    `UPDATE hubs SET owner_id = $1, claim_code_hash = NULL, claim_expires_at = NULL
     WHERE claim_code_hash = $2 AND claim_expires_at > now() AND owner_id IS NULL
     RETURNING id AS "instanceId", name, public_url AS "publicUrl"`,
    [account, hash(normalizeClaimCode(text(b.code)))],
  );
  if (!hub) throw bad("invalid_grant", "that claim code is wrong or expired");
  return json(hub);
}

/** A pass for a signed-in person to log in to one hub. */
export async function pass(req: Request, p: Params): Promise<Response> {
  await rateLimit(req, "pass", 60);
  const account = await authed(req);
  const id = hubId(p);
  if (!(await query("SELECT 1 FROM hubs WHERE id = $1", [id])).length) throw bad("invalid_request", "unknown hub");
  const [a] = await query<{ name: string; avatar: string | null; username: string | null }>(
    `SELECT a.display_name AS name, a.avatar_url AS avatar,
       (SELECT username FROM identities i WHERE i.account_id = a.id ORDER BY updated_at DESC LIMIT 1) AS username
     FROM accounts a WHERE a.id = $1`,
    [account],
  );
  const token = await sign({ aud: id, sub: account, name: a.name, username: a.username ?? a.name, avatar: a.avatar }, PASS_TTL_SECS);
  return json({ token, expiresIn: PASS_TTL_SECS });
}

/** The hubs the signed-in person has claimed. */
export async function owned(req: Request): Promise<Response> {
  const account = await authed(req);
  return json(
    await query(
      `SELECT id AS "instanceId", name, public_url AS "publicUrl", floor(extract(epoch FROM last_seen_at) * 1000)::float8 AS "lastSeen", relay_id AS "relayId"
       FROM hubs WHERE owner_id = $1 ORDER BY created_at`,
      [account],
    ),
  );
}

/** Hands a claimed hub to another account (the hub picks it up on its next check). */
export async function transfer(req: Request, p: Params): Promise<Response> {
  const account = await authed(req);
  const id = hubId(p);
  const handle = text((await body(req)).handle).trim().replace(/^@+/, "").toLowerCase();
  const [to] = await query<{ id: string }>("SELECT id FROM accounts WHERE handle = $1", [handle]);
  if (!to) throw bad("invalid_request", `no branchr account @${handle}`);
  if (to.id === account) throw bad("invalid_request", "that's you");
  const rows = await query(`UPDATE hubs SET owner_id = $1, ${UNLINK} WHERE id = $2 AND owner_id = $3 RETURNING id`, [to.id, id, account]);
  if (!rows.length) throw notFound();
  return empty(204);
}

/** Gives up a claim: the hub shows a claim code again. */
export async function release(req: Request, p: Params): Promise<Response> {
  const account = await authed(req);
  const rows = await query(`UPDATE hubs SET owner_id = NULL, ${UNLINK} WHERE id = $1 AND owner_id = $2 RETURNING id`, [hubId(p), account]);
  if (!rows.length) throw notFound();
  return empty(204);
}

export async function createSetupCode(req: Request): Promise<Response> {
  const account = await authed(req);
  const name = hubName((await body(req)).name);
  const [{ open }] = await query<{ open: number }>(
    "SELECT count(*)::int AS open FROM setup_codes WHERE account_id = $1 AND hub_id IS NULL AND expires_at > now()",
    [account],
  );
  if (open >= MAX_OPEN_SETUP_CODES) throw bad("invalid_request", "you have plenty of unused setup codes; use one of those");
  const code = setupCode();
  await query("INSERT INTO setup_codes (code_hash, account_id, name, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))", [
    hash(code),
    account,
    name,
    CODE_TTL_HOURS,
  ]);
  return json({ code, expiresInHours: CODE_TTL_HOURS });
}

/** For the setup page: has a hub come in with this code yet? */
export async function setupStatus(req: Request, p: { code: string }): Promise<Response> {
  const account = await authed(req);
  const [row] = await query(
    `SELECT name, hub_id AS "instanceId", expires_at < now() AS expired FROM setup_codes WHERE code_hash = $1 AND account_id = $2`,
    [hash(p.code.trim().toUpperCase()), account],
  );
  if (!row) throw notFound();
  return json(row);
}

/** A hub's first start with BRANCHR_SETUP: the code is its credential, once. */
export async function redeemSetupCode(req: Request): Promise<Response> {
  await rateLimit(req, "setup", 10);
  const b = await body(req);
  const url = publicUrl(b.publicUrl);
  const code = hash(text(b.code).trim().toUpperCase());
  const id = randomUUID();
  const secret = newSecret();
  await transaction(async (db) => {
    const { rows } = await db.query<{ account_id: string; name: string }>(
      "SELECT account_id, name FROM setup_codes WHERE code_hash = $1 AND hub_id IS NULL AND expires_at > now() FOR UPDATE",
      [code],
    );
    if (!rows[0]) throw bad("invalid_grant", "that setup code is unknown, used or expired; get a new one");
    await db.query("INSERT INTO hubs (id, secret_hash, name, public_url, owner_id, last_seen_at) VALUES ($1, $2, $3, $4, $5, now())", [
      id,
      hash(secret),
      rows[0].name,
      url,
      rows[0].account_id,
    ]);
    await db.query("UPDATE setup_codes SET hub_id = $1 WHERE code_hash = $2", [id, code]);
  });
  return json({ instanceId: id, secret, claimCode: "" });
}
