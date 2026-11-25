import { preflight, route } from "@/server/http";
import { release } from "@/server/relays";

export const DELETE = route(release);
export const OPTIONS = preflight;
