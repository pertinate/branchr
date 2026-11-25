//! Sign-in for branchr clients: OAuth 2 authorization code with PKCE (S256), with Discord as
//! the identity provider.
//!
//!   client ─/authorize─▶ branchr ─▶ Discord ─/auth/discord/callback─▶ branchr
//!          ◀── redirect_uri?code&state ───────────────────────────────┘
//!   client ─/token (code + verifier)─▶ access token (JWT) + refresh token
import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { account, upsertDiscordAccount } from "./accounts";
import { config } from "./config";
import { query } from "./db";
import { authorizeUrl, userForCode } from "./discord";
import { OAuthError, bad, empty, json, redirect } from "./http";
import { sign, verify } from "./keys";
import { rateLimit } from "./ratelimit";

const ACCESS_TTL_SECS = 15 * 60;
const REFRESH_TTL_DAYS = 90;
const CODE_TTL_SECS = 120;
const REQUEST_TTL_MINS = 10;
/** A rotated refresh token still works this long (concurrent refreshes from two tabs). */
const REUSE_GRACE_SECS = 60;
/** The audience of tokens for branchr's own API (hubs get their own). */
export const AUDIENCE = "branchr-id";

const randomToken = () => randomBytes(32).toString("base64url");
const hash = (token: string) => createHash("sha256").update(token).digest();

function withQuery(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.append(k, v);
  return u.toString();
}

function verifyPkce(verifier: string, challenge: string): boolean {
  return verifier.length >= 43 && verifier.length <= 128 && hash(verifier).toString("base64url") === challenge;
}

/** Deletes expired sign-in state now and then. */
async function gc() {
  if (Math.random() > 0.02) return;
  await query("DELETE FROM auth_requests WHERE created_at < now() - interval '1 hour'");
  await query("DELETE FROM auth_codes WHERE expires_at < now()");
  await query("DELETE FROM refresh_tokens WHERE expires_at < now()");
  await query("DELETE FROM rate_limits WHERE minute < now() - interval '1 hour'");
}

/** Starts a sign-in: remembers the client's PKCE challenge and sends the user to Discord. */
export async function authorize(req: Request): Promise<Response> {
  await rateLimit(req, "authorize");
  const q = new URL(req.url).searchParams;
  const redirectUri = q.get("redirect_uri") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  const state = q.get("state") ?? "";
  // Exact match only: the code goes wherever this points.
  if (!config().redirects.includes(redirectUri)) throw bad("invalid_request", "redirect_uri is not allowed");
  if (q.get("code_challenge_method") !== "S256" || challenge.length !== 43) throw bad("invalid_request", "a S256 code_challenge is required");
  if (!state || state.length > 256) throw bad("invalid_request", "state must be 1-256 characters");
  const id = randomToken();
  const discord = authorizeUrl(id);
  await gc();
  await query("INSERT INTO auth_requests (id, redirect_uri, code_challenge, client_state) VALUES ($1, $2, $3, $4)", [
    id,
    redirectUri,
    challenge,
    state,
  ]);
  return redirect(discord);
}

/** A page for failures we can't send back to the client (unknown or expired sign-in). */
function errorPage(message: string): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>branchr</title><body style="font:16px system-ui;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;height:100vh;margin:0"><div><h2>Couldn't sign in</h2><p>${message}</p><p>Go back to branchr and try again.</p></div>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** Discord sends the user back here. */
export async function discordCallback(req: Request): Promise<Response> {
  await rateLimit(req, "callback");
  const q = new URL(req.url).searchParams;
  const [pending] = await query<{ redirect_uri: string; code_challenge: string; client_state: string }>(
    `DELETE FROM auth_requests WHERE id = $1 AND created_at > now() - make_interval(mins => $2)
     RETURNING redirect_uri, code_challenge, client_state`,
    [q.get("state") ?? "", REQUEST_TTL_MINS],
  );
  if (!pending) return errorPage("This sign-in link expired or was already used.");
  const code = q.get("code");
  const error = q.get("error");
  if (!code || error) {
    // Declined at Discord: tell the client so it can stop waiting.
    return redirect(withQuery(pending.redirect_uri, { error: error ?? "access_denied", state: pending.client_state }));
  }
  const id = await upsertDiscordAccount(await userForCode(code));
  const ourCode = randomToken();
  await query(
    `INSERT INTO auth_codes (code_hash, account_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [hash(ourCode), id, pending.redirect_uri, pending.code_challenge, CODE_TTL_SECS],
  );
  return redirect(withQuery(pending.redirect_uri, { code: ourCode, state: pending.client_state }));
}

async function form(req: Request): Promise<(name: string) => string> {
  const body = new URLSearchParams(await req.text());
  return (name) => body.get(name) ?? "";
}

/** Redeems a one-time code, returning who it's for and a new sign-in family. */
async function fromCode(f: (name: string) => string) {
  if (!f("code")) throw bad("invalid_request", "code is required");
  const [row] = await query<{ account_id: string; redirect_uri: string; code_challenge: string }>(
    "DELETE FROM auth_codes WHERE code_hash = $1 AND expires_at > now() RETURNING account_id, redirect_uri, code_challenge",
    [hash(f("code"))],
  );
  if (!row) throw bad("invalid_grant", "the code is invalid or expired");
  if (f("redirect_uri") !== row.redirect_uri) throw bad("invalid_grant", "redirect_uri doesn't match");
  if (!verifyPkce(f("code_verifier"), row.code_challenge)) throw bad("invalid_grant", "code_verifier doesn't match");
  return { id: row.account_id, family: randomUUID() as string };
}

/** Uses up a refresh token, returning who it's for and its sign-in family. */
async function fromRefresh(f: (name: string) => string) {
  if (!f("refresh_token")) throw bad("invalid_request", "refresh_token is required");
  // Locks the row; `stale` is true only for a token rotated longer ago than the grace.
  const [row] = await query<{ account_id: string; family: string; stale: boolean }>(
    `WITH old AS (SELECT token_hash, rotated, rotated_at FROM refresh_tokens WHERE token_hash = $1 AND expires_at > now() FOR UPDATE)
     UPDATE refresh_tokens r SET rotated = true, rotated_at = COALESCE(old.rotated_at, now()) FROM old WHERE r.token_hash = old.token_hash
     RETURNING r.account_id, r.family, COALESCE(old.rotated AND old.rotated_at < now() - make_interval(secs => $2), false) AS stale`,
    [hash(f("refresh_token")), REUSE_GRACE_SECS],
  );
  if (!row) throw bad("invalid_grant", "the refresh token is invalid or expired");
  if (row.stale) {
    // A rotated token came back: someone else has a copy. End that sign-in.
    console.warn("refresh token reuse; revoking sign-in", row.family);
    await query("DELETE FROM refresh_tokens WHERE family = $1", [row.family]);
    throw bad("invalid_grant", "this sign-in was revoked; sign in again");
  }
  return { id: row.account_id, family: row.family };
}

export async function token(req: Request): Promise<Response> {
  await rateLimit(req, "token");
  const f = await form(req);
  const grant = f("grant_type");
  if (grant !== "authorization_code" && grant !== "refresh_token") {
    throw bad("unsupported_grant_type", "use authorization_code or refresh_token");
  }
  const { id, family } = await (grant === "authorization_code" ? fromCode(f) : fromRefresh(f));
  const refresh = randomToken();
  await query(
    "INSERT INTO refresh_tokens (token_hash, family, account_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    [hash(refresh), family, id, REFRESH_TTL_DAYS],
  );
  return json({
    access_token: await sign({ aud: AUDIENCE, sub: id }, ACCESS_TTL_SECS),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECS,
    refresh_token: refresh,
    account: await account(id),
  });
}

/** The account behind a `Bearer` access token. */
export async function authed(req: Request): Promise<string> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const id = bearer ? await verify(bearer, AUDIENCE) : null;
  if (!id) throw new OAuthError(401, "invalid_token", "unauthorized");
  return id;
}

export async function me(req: Request): Promise<Response> {
  return json(await account(await authed(req)));
}

/** Ends the sign-in a refresh token belongs to (every token in its family). */
export async function logout(req: Request): Promise<Response> {
  const f = await form(req);
  await query("DELETE FROM refresh_tokens WHERE family = (SELECT family FROM refresh_tokens WHERE token_hash = $1)", [hash(f("refresh_token"))]);
  return empty();
}
