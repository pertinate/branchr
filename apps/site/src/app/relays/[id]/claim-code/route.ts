import { preflight, route } from "@/server/http";
import { newClaimCode } from "@/server/relays";

export const POST = route(newClaimCode);
export const OPTIONS = preflight;
