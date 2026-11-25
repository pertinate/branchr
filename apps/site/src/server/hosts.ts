//! The hubs an account uses. A new device signs in once and the app reconnects to all of
//! them. Only addresses are kept, never anything from the hubs.
import "server-only";

import { query } from "./db";
import { bad, body, empty, json, text } from "./http";
import { authed } from "./oauth";

/** Per account, generously. */
const MAX_HOSTS = 100;

/** A hub's base address: its origin, plus a path when it's reached under one; an app page
 *  (`/app/`) or fragment on the end is dropped. */
function base(value: unknown): string {
  const u = URL.parse(text(value).trim());
  if (!u) throw bad("invalid_request", "url must be a URL");
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw bad("invalid_request", "url must be an http(s) address");
  return `${u.origin}${u.pathname.replace(/\/+$/, "").replace(/\/app$/, "")}`;
}

export async function list(req: Request): Promise<Response> {
  const account = await authed(req);
  return json(await query("SELECT url FROM account_hubs WHERE account_id = $1 ORDER BY added_at, url", [account]));
}

export async function add(req: Request): Promise<Response> {
  const account = await authed(req);
  const url = base((await body(req)).url);
  const [{ count }] = await query<{ count: number }>("SELECT count(*)::int AS count FROM account_hubs WHERE account_id = $1", [account]);
  if (count >= MAX_HOSTS) throw bad("invalid_request", "too many hubs");
  await query("INSERT INTO account_hubs (account_id, url) VALUES ($1, $2) ON CONFLICT DO NOTHING", [account, url]);
  return empty();
}

export async function remove(req: Request): Promise<Response> {
  const account = await authed(req);
  await query("DELETE FROM account_hubs WHERE account_id = $1 AND url = $2", [account, base((await body(req)).url)]);
  return empty();
}
