import { preflight, route } from "@/server/http";
import { setupStatus } from "@/server/hubs";

export const GET = route(setupStatus);
export const OPTIONS = preflight;
