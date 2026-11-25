import { add, list, remove } from "@/server/hosts";
import { preflight, route } from "@/server/http";

export const GET = route(list);
export const PUT = route(add);
export const DELETE = route(remove);
export const OPTIONS = preflight;
