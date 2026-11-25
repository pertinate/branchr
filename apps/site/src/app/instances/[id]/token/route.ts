import { preflight, route } from "@/server/http";
import { pass } from "@/server/hubs";

export const POST = route(pass);
export const OPTIONS = preflight;
