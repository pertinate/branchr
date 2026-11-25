import { preflight, route } from "@/server/http";
import { register } from "@/server/relays";

export const POST = route(register);
export const OPTIONS = preflight;
