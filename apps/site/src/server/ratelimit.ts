import "server-only";

import { query } from "./db";
import { OAuthError } from "./http";

/** At most `max` requests a minute per client address. Counted in the database, since
 *  requests land on different function instances. */
export async function rateLimit(req: Request, bucket: string, max = 30) {
  // Vercel sets these itself, replacing anything the client sent.
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const [row] = await query<{ count: number }>(
    `INSERT INTO rate_limits (key, minute, count) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (key, minute) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`,
    [`${bucket}:${ip}`],
  );
  if (row.count > max) throw new OAuthError(429, "rate_limited", "too many requests; try again in a minute");
}
