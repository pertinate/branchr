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
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
}

export const empty = (status = 200) => new Response(null, { status, headers: CORS });

export const notFound = () => new OAuthError(404, "not_found", "not found");

/** A JSON body's fields; anything but an object is refused. */
export async function body(req: Request): Promise<Record<string, unknown>> {
  const b: unknown = await req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("invalid_request", "a JSON object is required");
  return b as Record<string, unknown>;
}

export const text = (v: unknown) => (typeof v === "string" ? v : "");

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

/** Wraps a route handler so thrown errors become responses. */
export function route<P = unknown>(handler: (req: Request, params: P) => Promise<Response>) {
  return async (req: Request, context: { params: Promise<P> }) => {
    try {
      return await handler(req, await context.params);
    } catch (e) {
      if (e instanceof OAuthError) return json({ error: e.code, error_description: e.message }, e.status);
      console.error(e);
      return json({ error: "server_error", error_description: "internal error" }, 500);
    }
  };
}
