//! Discord OAuth: code exchange and the signed-in user, `identify` scope only.
import "server-only";

import { config } from "./config";
import { OAuthError } from "./http";

/** Honest about who we are; Discord asks API clients for a descriptive User-Agent. */
const USER_AGENT = "branchr-id/0.1 (+https://branchr.us)";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export const displayName = (u: DiscordUser) => u.global_name || u.username;

export function avatarUrl(u: DiscordUser): string {
  if (u.avatar) return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=256`;
  // Default avatars are picked from the id for new-style usernames.
  const n = /^\d+$/.test(u.id) ? Number((BigInt(u.id) >> BigInt(22)) % BigInt(6)) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

function credentials() {
  const c = config();
  if (!c.discordClientId || !c.discordClientSecret) throw new OAuthError(503, "server_error", "Discord sign-in isn't set up");
  return { ...c, id: c.discordClientId, secret: c.discordClientSecret, redirect: `${c.publicUrl}/auth/discord/callback` };
}

export function authorizeUrl(state: string): string {
  const c = credentials();
  const u = new URL(c.discordAuthorize);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: c.id,
    scope: "identify",
    redirect_uri: c.redirect,
    state,
    // Skip the consent screen for people who already approved us.
    prompt: "none",
  }).toString();
  return u.toString();
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), cache: "no-store" });
  } catch (e) {
    console.error("discord", e);
    throw new OAuthError(502, "upstream_error", "couldn't reach Discord");
  }
}

/** Exchanges Discord's code for the user it belongs to. */
export async function userForCode(code: string): Promise<DiscordUser> {
  const c = credentials();
  const t = await call(`${c.discordApi}/oauth2/token`, {
    method: "POST",
    headers: { "user-agent": USER_AGENT, authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: c.redirect }),
  });
  if (!t.ok) {
    console.warn("discord token exchange", t.status, await t.text());
    throw new OAuthError(502, "upstream_error", `discord rejected the sign-in (${t.status})`);
  }
  const { access_token } = (await t.json()) as { access_token: string };
  const r = await call(`${c.discordApi}/users/@me`, { headers: { "user-agent": USER_AGENT, authorization: `Bearer ${access_token}` } });
  if (!r.ok) throw new OAuthError(502, "upstream_error", `discord user lookup failed (${r.status})`);
  return (await r.json()) as DiscordUser;
}
