import { preflight, route } from "@/server/http";
import { heartbeat } from "@/server/relays";

export const POST = route(heartbeat);
export const OPTIONS = preflight;
