import { preflight, route } from "@/server/http";
import { register } from "@/server/hubs";

export const POST = route(register);
export const OPTIONS = preflight;
