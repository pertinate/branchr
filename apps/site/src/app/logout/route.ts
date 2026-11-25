import { logout } from "@/server/oauth";
import { preflight, route } from "@/server/http";

export const POST = route(logout);
export const OPTIONS = preflight;
