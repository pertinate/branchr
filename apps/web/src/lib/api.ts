import { type Instance, activeInstance, hostOf } from "@/lib/instances";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type Api = <T = void>(method: Method, path: string, body?: unknown) => Promise<T>;

/** The active instance's API (the one on screen). */
export function api<T = void>(method: Method, path: string, body?: unknown): Promise<T> {
  return activeInstance().api<T>(method, path, body);
}

export function createApi(inst: Instance): Api {
  return (method, path, body) => request(inst, method, path, body);
}

async function request<T>(inst: Instance, method: Method, path: string, body?: unknown): Promise<T> {
  const { serverUrl, token } = inst.auth.getState();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${serverUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && token) {
    inst.auth.getState().logout();
  }
  if (!res.ok) {
    // A hub explains itself in JSON; anything else is something in the way (HTTP/2 doesn't
    // even send a status text).
    let msg = `Couldn't reach the hub at ${hostOf(serverUrl)} (HTTP ${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* non-json error */
    }
    throw new ApiError(res.status, msg);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function gatewayUrl(serverUrl: string) {
  return serverUrl.replace(/^http/, "ws") + "/gateway";
}
