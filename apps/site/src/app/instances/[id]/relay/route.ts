import { preflight, route } from "@/server/http";
import { link } from "@/server/relays";

export const PUT = route(link);
export const OPTIONS = preflight;
