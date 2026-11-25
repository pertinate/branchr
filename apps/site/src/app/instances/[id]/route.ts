import { preflight, route } from "@/server/http";
import { status } from "@/server/hubs";

export const GET = route(status);
export const OPTIONS = preflight;
