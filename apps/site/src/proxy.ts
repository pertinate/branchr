import type { NextRequest } from "next/server";

// `/app` → `/app/`. A redirect in next.config would match both and loop.
export function proxy(request: NextRequest) {
  const url = new URL(request.url);
  if (url.pathname === "/app") {
    url.pathname = "/app/";
    return Response.redirect(url, 308);
  }
}

export const config = { matcher: "/app" };
