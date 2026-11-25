import { preflight, route } from "@/server/http";
import { claim } from "@/server/hubs";

export const POST = route(claim);
export const OPTIONS = preflight;
