import type { Attachment } from "@app/protocol";
import { Download, FileIcon } from "lucide-react";
import { memo } from "react";

import { attachmentUrl, formatBytes } from "@/lib/upload";

const MAX_W = 400;
const MAX_H = 300;

/** Fits media in a box while keeping aspect, so space is reserved before it loads. */
function fit(a: Attachment) {
  if (!a.width || !a.height) return { width: MAX_W, height: undefined as number | undefined };
  const scale = Math.min(1, MAX_W / a.width, MAX_H / a.height);
  return { width: Math.round(a.width * scale), height: Math.round(a.height * scale) };
}

export const Attachments = memo(function Attachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      {items.map((a) => {
        const url = attachmentUrl(a.url);
        const type = a.contentType;
        if (/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) {
          const s = fit(a);
          return (
            <a key={a.id} href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md bg-muted" style={s}>
              <img src={url} alt={a.filename} loading="lazy" decoding="async" width={s.width} height={s.height} className="size-full object-contain" />
            </a>
          );
        }
        if (type.startsWith("video/")) {
          const s = fit(a);
          return <video key={a.id} src={url} controls preload="metadata" className="rounded-md bg-black" style={s} />;
        }
        if (type.startsWith("audio/")) {
          return (
            <div key={a.id} className="w-96 rounded-md bg-muted p-2">
              <div className="mb-1 truncate text-sm">{a.filename}</div>
              <audio src={url} controls preload="none" className="w-full" />
            </div>
          );
        }
        return (
          <a key={a.id} href={url} download={a.filename} className="flex w-96 items-center gap-3 rounded-md border border-border bg-muted p-3 hover:bg-accent">
            <FileIcon className="size-8 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-sky-400">{a.filename}</div>
              <div className="text-xs text-muted-foreground">{formatBytes(a.size)}</div>
            </div>
            <Download className="size-5 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
});
