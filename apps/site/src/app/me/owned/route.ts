import { preflight, route } from "@/server/http";
import { owned } from "@/server/hubs";

export const GET = route(owned);
export const OPTIONS = preflight;
