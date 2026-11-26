// Hubs and relays check in every minute. Answering from Vercel's runtime cache while
// nothing has changed leaves the database alone long enough to pause.
import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";
import { getCache } from "@vercel/functions";

import { hash } from "./codes";
import { OAuthError, notFound } from "./http";

/** An answer is reused until the next multiple of this (they all go stale together, so the
 *  database wakes once), in case word of a change got lost. */
const WINDOW_SECS = () => Number(process.env.CHECKIN_CACHE_SECS) || 3600;

// Keys as they are: the default shortens them to 32 bits, where two could meet.
const cache = () => getCache({ namespace: "checkin", keyHashFunction: (key) => key });

/** Call after committing anything a check-in answers with: who owns a hub or relay, which
 *  relay carries a hub, its ports, or where a relay is. Every cached answer is dropped. */
export async function changed(): Promise<void> {
  await cache().set("version", randomUUID());
}

async function version(): Promise<string> {
  const known = await cache().get("version");
  if (typeof known === "string") return known;
  const made = randomUUID();
  await cache().set("version", made);
  return made;
}

/**
 * The record behind a hub's or relay's `Authorization: Bearer <its secret>`, from the cache
 * if still current, else from `load`. `fresh` says the database was read. One we don't know
 * is "not found", which tells it to register again.
 */
export async function checkIn<T extends { secretHash: string }>(req: Request, key: string, load: () => Promise<T | null>): Promise<{ record: T; fresh: boolean }> {
  const window = WINDOW_SECS();
  // Read before the database: a change landing in between leaves this answer outdated.
  const stamp = `${await version()}/${Math.floor(Date.now() / 1000 / window)}`;
  const hit = (await cache().get(key)) as { stamp: string; record: T } | null | undefined;
  const fresh = hit?.stamp !== stamp;
  const record = fresh ? await load() : hit.record;
  if (!record) throw notFound();
  const secret = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!secret || !timingSafeEqual(hash(secret), Buffer.from(record.secretHash, "hex"))) throw new OAuthError(401, "invalid_token", "unauthorized");
  if (fresh) await cache().set(key, { stamp, record }, { ttl: window });
  return { record, fresh };
}
