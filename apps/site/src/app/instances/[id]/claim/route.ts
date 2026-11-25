import { preflight, route } from "@/server/http";
import { release } from "@/server/hubs";

export const DELETE = route(release);
export const OPTIONS = preflight;
