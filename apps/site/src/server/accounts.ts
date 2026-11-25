import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { query, transaction } from "./db";
import { type DiscordUser, avatarUrl, displayName } from "./discord";
import { OAuthError } from "./http";

export interface Account {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function account(id: string): Promise<Account> {
  const [a] = await query<Account>(`SELECT id, display_name AS "displayName", avatar_url AS "avatarUrl" FROM accounts WHERE id = $1`, [id]);
  if (!a) throw new OAuthError(401, "invalid_token", "unauthorized");
  return a;
}

/** A handle for a new account: the Discord username, lowercased, or with a number added
 *  when someone has it already. */
async function freeHandle(db: PoolClient, username: string): Promise<string> {
  let base = username.toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 28);
  if (base.length < 2) base = "user";
  const { rows } = await db.query<{ handle: string }>("SELECT handle FROM accounts WHERE handle LIKE $1 || '%'", [base]);
  const taken = new Set(rows.map((r) => r.handle));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function upsert(u: DiscordUser): Promise<string> {
  return transaction(async (db) => {
    const { rows } = await db.query<{ account_id: string }>(
      "SELECT account_id FROM identities WHERE provider = 'discord' AND subject = $1 FOR UPDATE",
      [u.id],
    );
    if (rows[0]) {
      const id = rows[0].account_id;
      await db.query("UPDATE accounts SET display_name = $1, avatar_url = $2 WHERE id = $3", [displayName(u), avatarUrl(u), id]);
      await db.query("UPDATE identities SET username = $1, updated_at = now() WHERE provider = 'discord' AND subject = $2", [u.username, u.id]);
      return id;
    }
    const id = randomUUID();
    await db.query("INSERT INTO accounts (id, display_name, avatar_url, handle) VALUES ($1, $2, $3, $4)", [
      id,
      displayName(u),
      avatarUrl(u),
      await freeHandle(db, u.username),
    ]);
    // Fails if another first sign-in won the race, discarding this account.
    await db.query("INSERT INTO identities (provider, subject, account_id, username) VALUES ('discord', $1, $2, $3)", [u.id, id, u.username]);
    return id;
  });
}

/** The account for a Discord user, created on first sign-in. Name and avatar follow Discord. */
export async function upsertDiscordAccount(u: DiscordUser): Promise<string> {
  // Retried when racing another sign-in for the same identity or handle.
  for (let attempt = 1; ; attempt++) {
    try {
      return await upsert(u);
    } catch (e) {
      if (attempt >= 3 || (e as { code?: string }).code !== "23505") throw e;
    }
  }
}
