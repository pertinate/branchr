import "server-only";

/** OAuth-style errors: `{"error": code, "error_description": …}`. */
export class OAuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (code: string, message: string) => new OAuthError(400, code, message);

// Bearer tokens only, no cookies, so any origin may call (hubs serve the web client).
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
}

export const empty = () => new Response(null, { status: 200, headers: CORS });

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

/** Wraps a route handler so thrown errors become responses. */
export function route(handler: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof OAuthError) return json({ error: e.code, error_description: e.message }, e.status);
      console.error(e);
      return json({ error: "server_error", error_description: "internal error" }, 500);
    }
  };
}
