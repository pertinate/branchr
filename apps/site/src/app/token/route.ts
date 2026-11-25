import { token } from "@/server/oauth";
import { preflight, route } from "@/server/http";

export const POST = route(token);
export const OPTIONS = preflight;
