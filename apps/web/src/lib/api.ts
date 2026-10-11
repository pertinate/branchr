import { useAuth } from "@/stores/auth";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function api<T = void>(method: Method, path: string, body?: unknown): Promise<T> {
  const { serverUrl, token } = useAuth.getState();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${serverUrl}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && token) {
    useAuth.getState().logout();
  }
  if (!res.ok) {
    let msg = res.statusText;
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
