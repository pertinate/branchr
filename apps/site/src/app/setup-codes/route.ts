import { preflight, route } from "@/server/http";
import { createSetupCode } from "@/server/hubs";

export const POST = route(createSetupCode);
export const OPTIONS = preflight;
