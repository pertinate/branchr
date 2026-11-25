import { preflight, route } from "@/server/http";
import { mine } from "@/server/relays";

export const GET = route(mine);
export const OPTIONS = preflight;
