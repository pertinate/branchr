import { discordCallback } from "@/server/oauth";
import { route } from "@/server/http";

export const GET = route(discordCallback);
