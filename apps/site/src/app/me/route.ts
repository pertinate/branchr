import { me } from "@/server/oauth";
import { preflight, route } from "@/server/http";

export const GET = route(me);
export const OPTIONS = preflight;
