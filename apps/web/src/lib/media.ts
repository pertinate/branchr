/** Pictures (icons, banners, avatars) uploaded to a host are paths on it. */
import { type Instance, useInstance } from "@/lib/instances";

export function mediaUrl(inst: Pick<Instance, "url">, url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith("/") ? `${inst.url}${url}` : url;
}

/** `url` resolved against this component's host. */
export function useMediaUrl(url: string | null | undefined): string | undefined {
  return mediaUrl(useInstance(), url);
}

/** Uploads a picture file to `path` (PUT), returning the updated object. */
export async function uploadPicture<T>(inst: Instance, path: string, file: File): Promise<T> {
  const { serverUrl, token } = inst.auth.getState();
  const res = await fetch(`${serverUrl}/api${path}`, {
    method: "PUT",
    headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let msg = res.status === 413 ? "That picture is over 10 MB" : res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}
