import type { Attachment } from "@app/protocol";
import { Download, FileIcon } from "lucide-react";
import { memo, useState } from "react";

import { ImageViewer } from "@/components/chat/image-viewer";
import { attachmentUrl, formatBytes } from "@/lib/upload";

const MAX_W = 400;
const MAX_H = 300;

/** Fits media in a box while keeping aspect, so space is reserved before it loads. */
function fit(a: Attachment) {
  if (!a.width || !a.height) return { width: MAX_W, height: undefined as number | undefined };
  const scale = Math.min(1, MAX_W / a.width, MAX_H / a.height);
  return { width: Math.round(a.width * scale), height: Math.round(a.height * scale) };
}

const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp|avif)$/.test(a.contentType);

export const Attachments = memo(function Attachments({ items }: { items: Attachment[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (!items.length) return null;
  const images = items.filter(isImage);
  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      <ImageViewer images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      {items.map((a) => {
        const url = attachmentUrl(a.url);
        const type = a.contentType;
        if (isImage(a)) {
          const s = fit(a);
          return (
            <button
              data-attachment-url={url}
              data-attachment-name={a.filename}
              key={a.id}
              type="button"
              onClick={() => setViewing(images.indexOf(a))}
              aria-label={`View ${a.filename}`}
              className="block cursor-zoom-in overflow-hidden rounded-md bg-muted"
              style={s}
            >
              <img src={attachmentUrl(a.thumbUrl ?? a.url)} alt={a.filename} loading="lazy" decoding="async" width={s.width} height={s.height} className="size-full object-contain" />
            </button>
          );
        }
        if (type.startsWith("video/")) {
          const s = fit(a);
          return <video key={a.id} data-attachment-url={url} data-attachment-name={a.filename} data-attachment-video src={url} controls preload="metadata" className="rounded-md bg-black" style={s} />;
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
