import { query } from "@/server/db";
import { route } from "@/server/http";

export const dynamic = "force-dynamic";
/** Healthy only with the database reachable and migrated. */
export const GET = route(async () => {
  await query("SELECT 1 FROM accounts LIMIT 1");
  return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
});
