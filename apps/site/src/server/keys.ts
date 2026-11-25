//! Ed25519 signing keys for the JWTs we issue, published as a JWKS so hubs can verify
//! tokens without calling back here.
//!
//! Keys rotate on their own: every KEY_ROTATE_DAYS (90; 0 turns it off) a new key is
//! published an hour before it starts signing, so hubs already have it, and the old one is
//! retired an hour after that. Rotation happens as keys are loaded (there's no timer here).
import "server-only";

import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import { config } from "./config";
import { transaction } from "./db";

const OVERLAP_SECS = 3600;
const CACHE_MS = 5 * 60_000;
const LOCK = 0x62726b79; // "brky"

interface Key {
  kid: string;
  seed: Buffer;
  public_key: Buffer;
  activates_at: Date;
}

let cache: { at: number; keys: Key[] } | null = null;

/** The raw public half of an Ed25519 seed. */
function publicOf(seed: Buffer): Buffer {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  return Buffer.from(jwk.x!, "base64url");
}

/** Every unretired key, newest first, rotating first if it's due. */
async function load(fresh = false): Promise<Key[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.keys;
  const days = config().keyRotateDays;
  const keys = await transaction(async (db) => {
    // One instance at a time, so two never create keys side by side.
    await db.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
    const insert = async (aheadSecs: number) => {
      const seed = randomBytes(32);
      await db.query(
        "INSERT INTO signing_keys (kid, seed, public_key, activates_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
        [randomUUID().replaceAll("-", ""), seed, publicOf(seed), aheadSecs],
      );
    };
    const { rows: signing } = await db.query("SELECT 1 FROM signing_keys WHERE NOT retired AND activates_at <= now() LIMIT 1");
    if (!signing.length) await insert(0);
    else if (days > 0) {
      const { rows } = await db.query(
        "SELECT 1 FROM signing_keys WHERE NOT retired AND (activates_at > now() OR activates_at > now() - make_interval(secs => $1)) LIMIT 1",
        [days * 86400],
      );
      if (!rows.length) await insert(OVERLAP_SECS);
    }
    // Retired: older than the key that's been signing for at least the overlap.
    await db.query(
      `UPDATE signing_keys SET retired = true WHERE NOT retired AND activates_at <
         (SELECT max(activates_at) FROM signing_keys WHERE NOT retired AND activates_at <= now() - make_interval(secs => $1))`,
      [OVERLAP_SECS],
    );
    return (await db.query<Key>("SELECT kid, seed, public_key, activates_at FROM signing_keys WHERE NOT retired ORDER BY activates_at DESC")).rows;
  });
  cache = { at: Date.now(), keys };
  return keys;
}

const publicJwk = (k: Key) => ({ kty: "OKP", crv: "Ed25519", x: k.public_key.toString("base64url") });

export async function jwks() {
  return { keys: (await load()).map((k) => ({ ...publicJwk(k), alg: "EdDSA", use: "sig", kid: k.kid })) };
}

export async function sign(claims: { aud: string; sub: string } & Record<string, unknown>, ttlSecs: number): Promise<string> {
  const key = (await load()).find((k) => k.activates_at.getTime() <= Date.now());
  if (!key) throw new Error("no active signing key");
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: config().publicUrl, ...claims, iat, exp: iat + ttlSecs })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: key.kid })
    .sign(await importJWK({ ...publicJwk(key), d: key.seed.toString("base64url") }, "EdDSA"));
}

/** The subject of a token we issued for `audience`, or null. */
export async function verify(token: string, audience: string): Promise<string | null> {
  try {
    const { kid } = decodeProtectedHeader(token);
    // An unknown key id may be one another instance just made.
    const key = (await load()).find((k) => k.kid === kid) ?? (await load(true)).find((k) => k.kid === kid);
    if (!key) return null;
    const { payload } = await jwtVerify(token, await importJWK(publicJwk(key), "EdDSA"), {
      issuer: config().publicUrl,
      audience,
      algorithms: ["EdDSA"],
      requiredClaims: ["exp", "sub"],
    });
    return payload.sub ?? null;
  } catch (e) {
    // Bad tokens are the caller's problem; anything else (the database) is ours.
    if (e instanceof Error && "code" in e && String(e.code).startsWith("ERR_J")) return null;
    if (e instanceof TypeError) return null;
    throw e;
  }
}
