import { preflight, route } from "@/server/http";
import { relayPass } from "@/server/relays";

export const POST = route(relayPass);
export const OPTIONS = preflight;
