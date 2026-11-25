import { preflight, route } from "@/server/http";
import { redeemSetupCode } from "@/server/hubs";

export const POST = route(redeemSetupCode);
export const OPTIONS = preflight;
