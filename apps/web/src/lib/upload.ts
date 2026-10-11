import type { Attachment } from "@app/protocol";

import { useApp } from "@/stores/app";
import { useAuth } from "@/stores/auth";

/** Reads pixel dimensions so messages can reserve space before media loads. */
async function mediaSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    if (file.type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      return size;
    }
    if (file.type.startsWith("video/")) {
      const url = URL.createObjectURL(file);
      try {
        return await new Promise((resolve) => {
          const v = document.createElement("video");
          v.preload = "metadata";
          v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight });
          v.onerror = () => resolve(null);
          v.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    /* not decodable here; fine */
  }
  return null;
}

/** Streams a file to the server with progress (0..1). */
export async function uploadAttachment(channelId: string, file: File, onProgress: (p: number) => void, signal?: AbortSignal): Promise<Attachment> {
  const { serverUrl, token } = useAuth.getState();
  const max = useApp.getState().maxUploadBytes;
  if (file.size > max) throw new Error(`Too large: the limit is ${formatBytes(max)}`);
  const size = await mediaSize(file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${serverUrl}/api/channels/${channelId}/attachments`);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-filename", encodeURIComponent(file.name));
    if (size) {
      xhr.setRequestHeader("x-width", String(size.width));
      xhr.setRequestHeader("x-height", String(size.height));
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else {
        // statusText is empty over HTTP/2+, and an empty message would read as "no error".
        let msg = xhr.statusText || `upload failed (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {
          /* non-json */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export function attachmentUrl(path: string) {
  return `${useAuth.getState().serverUrl}${path}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
