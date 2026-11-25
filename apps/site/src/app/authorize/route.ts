import { authorize } from "@/server/oauth";
import { route } from "@/server/http";

export const GET = route(authorize);
