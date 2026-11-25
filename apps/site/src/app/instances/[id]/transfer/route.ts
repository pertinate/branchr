import { preflight, route } from "@/server/http";
import { transfer } from "@/server/hubs";

export const POST = route(transfer);
export const OPTIONS = preflight;
