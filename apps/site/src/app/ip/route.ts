import { preflight, route } from "@/server/http";

/** The caller's public address, which a hub at home asks for to tell voice clients. */
export const GET = route(async (req) => {
  // Vercel sets these itself, replacing anything the client sent.
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return new Response(ip ?? "", { status: ip ? 200 : 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
});
export const OPTIONS = preflight;
