//! Relays: servers with a public address that carry hubs which have none.
//!
//! 1. The relay registers: `POST /relays` → id, secret and a claim code.
//! 2. Its owner claims it, then links their own hubs to it.
//! 3. A linked hub asks for a pass naming that relay and the media ports it was given.
//! 4. The relay's heartbeat tells it which hubs are linked, so unlinking cuts them off.
//!
//! A relay only ever carries hubs with the same owner.
import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { changed, checkIn } from "./checkins";
import { claimCode, hash, normalizeClaimCode } from "./codes";
import { query, transaction } from "./db";
import { OAuthError, bad, body, empty, json, notFound, text } from "./http";
import { hubAuth, uuid } from "./hubs";
import { sign } from "./keys";
import { authed } from "./oauth";
import { rateLimit } from "./ratelimit";

const CODE_TTL_HOURS = 24;
const PASS_TTL_SECS = 5 * 60;
/** One media port per voice server worker. */
const MAX_PORTS = 64;

type Params = { id: string };

export async function register(req: Request): Promise<Response> {
  await rateLimit(req, "register-relay", 10);
  const name = text((await body(req)).name).trim();
  if (!name || [...name].length > 100) throw bad("invalid_request", "a relay's name is 1-100 characters");
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const code = claimCode();
  await query(
    `INSERT INTO relays (id, secret_hash, name, claim_code_hash, claim_expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [id, hash(secret), name, hash(code), CODE_TTL_HOURS],
  );
  return json({ relayId: id, secret, claimCode: code });
}

/** What a relay's check-ins are answered with. */
interface RelayRecord {
  secretHash: string;
  ownerId: string | null;
  /** What it last reported, as `[quic, fp, web, publicIp, udpStart, udpEnd]`. */
  about: unknown[];
  hubs: { id: string; udpBase: number; udpPorts: number }[];
}

/** The relay behind this request's secret (see `checkIn`). */
function relayAuth(req: Request, id: string) {
  return checkIn<RelayRecord>(req, `relay:${id}`, async () => {
    const [row] = await query<RelayRecord>(
      `SELECT encode(r.secret_hash, 'hex') AS "secretHash", r.owner_id AS "ownerId",
         json_build_array(r.quic, r.fp, r.web, r.public_ip, r.udp_start, r.udp_end) AS about,
         coalesce((SELECT json_agg(json_build_object('id', h.id, 'udpBase', h.relay_port_base, 'udpPorts', h.relay_port_count) ORDER BY h.relay_port_base)
           FROM hubs h WHERE h.relay_id = r.id AND h.owner_id = r.owner_id AND h.relay_port_base IS NOT NULL), '[]') AS hubs
       FROM relays r WHERE r.id = $1`,
      [id],
    );
    return row ?? null;
  });
}

/** The relay reports where it is, and learns its owner and linked hubs. */
export async function heartbeat(req: Request, p: Params): Promise<Response> {
  const id = uuid(p.id);
  const { record, fresh } = await relayAuth(req, id);
  const b = await body(req);
  const quic = text(b.quic);
  const fp = text(b.fp).toLowerCase();
  const web = text(b.web).replace(/\/+$/, "");
  const ip = text(b.publicIp) || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const [start, end] = [Number(b.udpStart), Number(b.udpEnd)];
  if (!/^[^\s/]{1,250}:\d{1,5}$/.test(quic)) throw bad("invalid_request", "quic must be host:port");
  if (!/^[0-9a-f]{64}$/.test(fp)) throw bad("invalid_request", "fp must be a sha256 fingerprint");
  if (web.length > 300 || !/^https?:$/.test(URL.parse(web)?.protocol ?? "")) throw bad("invalid_request", "web must be a URL");
  if (!isIP(ip)) throw bad("invalid_request", "publicIp must be an IP address");
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end) {
    throw bad("invalid_request", "udpStart..udpEnd must be ports from 1024");
  }
  const about = [quic, fp, web, ip, start, end];
  const moved = JSON.stringify(about) !== JSON.stringify(record.about);
  // `last_seen_at` is when we last looked it up, not every check-in.
  if (fresh || moved) {
    await query(
      "UPDATE relays SET quic = $2, fp = $3, web = $4, public_ip = $5, udp_start = $6, udp_end = $7, last_seen_at = now() WHERE id = $1",
      [id, ...about],
    );
  }
  if (moved) await changed();
  return json({ ownerId: record.ownerId, hubs: record.hubs });
}

/** For the relay itself: a fresh claim code. */
export async function newClaimCode(req: Request, p: Params): Promise<Response> {
  const id = uuid(p.id);
  await rateLimit(req, "claim-code");
  await relayAuth(req, id);
  const code = claimCode();
  const rows = await query(
    `UPDATE relays SET claim_code_hash = $1, claim_expires_at = now() + make_interval(hours => $2)
     WHERE id = $3 AND owner_id IS NULL RETURNING id`,
    [hash(code), CODE_TTL_HOURS, id],
  );
  if (!rows.length) throw bad("invalid_request", "this relay is already claimed");
  return json({ claimCode: code });
}

export async function claim(req: Request): Promise<Response> {
  await rateLimit(req, "claim", 10);
  const account = await authed(req);
  const b = await body(req);
  const [relay] = await query(
    `UPDATE relays SET owner_id = $1, claim_code_hash = NULL, claim_expires_at = NULL
     WHERE claim_code_hash = $2 AND claim_expires_at > now() AND owner_id IS NULL RETURNING id AS "relayId", name`,
    [account, hash(normalizeClaimCode(text(b.code)))],
  );
  if (!relay) throw bad("invalid_grant", "that claim code is wrong or expired");
  await changed();
  return json(relay);
}

/** Gives up a relay: its hubs are unlinked, and it shows a claim code again. */
export async function release(req: Request, p: Params): Promise<Response> {
  const account = await authed(req);
  const id = uuid(p.id);
  await transaction(async (db) => {
    const { rowCount } = await db.query("UPDATE relays SET owner_id = NULL WHERE id = $1 AND owner_id = $2", [id, account]);
    if (!rowCount) throw notFound();
    await db.query("UPDATE hubs SET relay_id = NULL, relay_port_base = NULL, relay_port_count = NULL WHERE relay_id = $1", [id]);
  });
  await changed();
  return empty(204);
}

export async function mine(req: Request): Promise<Response> {
  const account = await authed(req);
  return json(
    await query(
      `SELECT id AS "relayId", name, web, floor(extract(epoch FROM last_seen_at) * 1000)::float8 AS "lastSeen"
       FROM relays WHERE owner_id = $1 ORDER BY created_at`,
      [account],
    ),
  );
}

/** The owner picks which of their relays carries a hub (or none). */
export async function link(req: Request, p: Params): Promise<Response> {
  const account = await authed(req);
  const hub = uuid(p.id);
  const wanted = (await body(req)).relayId;
  const relay = wanted === null ? null : uuid(text(wanted));
  await transaction(async (db) => {
    if (relay) {
      // Held, so the relay can't change hands while we link to it.
      const { rowCount } = await db.query("SELECT 1 FROM relays WHERE id = $1 AND owner_id = $2 FOR SHARE", [relay, account]);
      if (!rowCount) throw notFound();
    }
    const { rowCount } = await db.query(
      `UPDATE hubs SET relay_id = $3,
         relay_port_base = CASE WHEN relay_id IS NOT DISTINCT FROM $3 THEN relay_port_base END,
         relay_port_count = CASE WHEN relay_id IS NOT DISTINCT FROM $3 THEN relay_port_count END
       WHERE id = $1 AND owner_id = $2`,
      [hub, account, relay],
    );
    if (!rowCount) throw notFound();
  });
  await changed();
  return empty(204);
}

/** The first run of `count` free ports in `start..end`, around the `taken` runs. */
function freeBlock(start: number, end: number, count: number, taken: { base: number; count: number }[]): number | null {
  let base = start;
  for (const t of [...taken].sort((a, b) => a.base - b.base)) {
    if (base + count <= t.base) break;
    base = Math.max(base, t.base + t.count);
  }
  return base + count - 1 <= end ? base : null;
}

const noRelay = () => new OAuthError(404, "no_relay", "no relay is linked to this hub");

/**
 * For a hub: its relay and its `ports` media ports there, with a pass to connect. Polling
 * hubs send `pass: false` until they need to connect, which keeps the database out of it.
 */
export async function relayPass(req: Request, p: Params): Promise<Response> {
  const id = uuid(p.id);
  const hub = await hubAuth(req, id);
  const b = await body(req);
  const ports = Number(b.ports);
  if (!Number.isInteger(ports) || ports < 1 || ports > MAX_PORTS) throw bad("invalid_request", `ports must be 1-${MAX_PORTS}`);
  if (b.pass === false) {
    const { relay, ports: mine } = hub;
    if (!relay) throw noRelay();
    if (mine?.count === ports && mine.base >= relay.udpStart && mine.base + ports - 1 <= relay.udpEnd) {
      const { id: relayId, quic, fp, web, publicIp } = relay;
      return json({ relay: { id: relayId, quic, fp, web, publicIp }, udpBase: mine.base, udpPorts: ports });
    }
  }
  const linked = await transaction(async (db) => {
    // The relay's row is locked while ports are handed out, so two hubs never get the same.
    const { rows } = await db.query<{
      relay_id: string; owner_id: string; quic: string; fp: string; web: string; public_ip: string; udp_start: number; udp_end: number;
    }>(
      `SELECT r.id AS relay_id, r.owner_id, r.quic, r.fp, r.web, r.public_ip, r.udp_start, r.udp_end
       FROM hubs h JOIN relays r ON r.id = h.relay_id AND r.owner_id = h.owner_id
       WHERE h.id = $1 AND r.quic IS NOT NULL FOR UPDATE OF r`,
      [id],
    );
    const relay = rows[0];
    if (!relay) throw noRelay();
    const all = await db.query<{ id: string; base: number; count: number }>(
      "SELECT id, relay_port_base AS base, relay_port_count AS count FROM hubs WHERE relay_id = $1 AND relay_port_base IS NOT NULL",
      [relay.relay_id],
    );
    const mine = all.rows.find((h) => h.id === id);
    const others = all.rows.filter((h) => h.id !== id);
    const fits = mine && mine.count === ports && mine.base >= relay.udp_start && mine.base + ports - 1 <= relay.udp_end;
    const base = fits ? mine.base : freeBlock(relay.udp_start, relay.udp_end, ports, others);
    if (base === null) {
      throw new OAuthError(409, "no_ports", `the relay hasn't ${ports} free media ports; widen its range or give the voice server fewer workers`);
    }
    const moved = mine?.base !== base || mine.count !== ports;
    if (moved) await db.query("UPDATE hubs SET relay_port_base = $2, relay_port_count = $3 WHERE id = $1", [id, base, ports]);
    return { relay, base, moved };
  });
  const { relay, base, moved } = linked;
  if (moved) await changed();
  return json({
    ...(b.pass !== false && {
      token: await sign({ aud: relay.relay_id, sub: id, owner: relay.owner_id, udpBase: base, udpPorts: ports }, PASS_TTL_SECS),
      expiresIn: PASS_TTL_SECS,
    }),
    relay: { id: relay.relay_id, quic: relay.quic, fp: relay.fp, web: relay.web, publicIp: relay.public_ip },
    udpBase: base,
    udpPorts: ports,
  });
}
