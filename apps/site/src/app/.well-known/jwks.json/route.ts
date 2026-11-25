import { json, preflight, route } from "@/server/http";
import { jwks } from "@/server/keys";

export const dynamic = "force-dynamic";
export const GET = route(async () => json(await jwks()));
export const OPTIONS = preflight;
