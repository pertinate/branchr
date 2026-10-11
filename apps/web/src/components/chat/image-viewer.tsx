import type { Attachment } from "@app/protocol";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { attachmentUrl, formatBytes } from "@/lib/upload";

/**
 * Full-screen view of a message's images. Click the image to toggle between fit-to-screen
 * and actual size; arrows step through the message's other images.
 */
export function ImageViewer({ images, index, onIndex, onClose }: { images: Attachment[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => setZoom(false), [index]);
  const a = index === null ? undefined : images[index];
  const many = images.length > 1;
  const step = (d: number) => index !== null && onIndex((index + d + images.length) % images.length);

  const url = a ? attachmentUrl(a.url) : "";
  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => toast.success("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );

  return (
    <DialogPrimitive.Root open={!!a} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-open:animate-in data-open:fade-in-0" />
        <DialogPrimitive.Content
          data-testid="image-viewer"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onKeyDown={(e) => {
            if (!many) return;
            if (e.key === "ArrowLeft") step(-1);
            else if (e.key === "ArrowRight") step(1);
          }}
        >
          {a && (
            <>
              <div className="flex items-center gap-3 px-4 py-3 text-sm text-white/90">
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="truncate font-medium">{a.filename}</DialogPrimitive.Title>
                  <div className="text-xs text-white/60">
                    {a.width && a.height ? `${a.width}×${a.height} · ` : ""}
                    {formatBytes(a.size)}
                    {many && ` · ${index! + 1} of ${images.length}`}
                  </div>
                </div>
                <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-white/10" title="Open original">
                  <ExternalLink className="size-4" /> Open original
                </a>
                <button onClick={copy} className="rounded-md p-1.5 hover:bg-white/10" title="Copy link" aria-label="Copy link">
                  <Copy className="size-4" />
                </button>
                <a href={url} download={a.filename} className="rounded-md p-1.5 hover:bg-white/10" title="Download" aria-label="Download">
                  <Download className="size-4" />
                </a>
                <DialogPrimitive.Close className="rounded-md p-1.5 hover:bg-white/10" aria-label="Close">
                  <X className="size-5" />
                </DialogPrimitive.Close>
              </div>
              <div
                className={zoom ? "relative min-h-0 flex-1 overflow-auto" : "relative flex min-h-0 flex-1 items-center justify-center p-4 pt-0"}
                // A click on the backdrop (not the image) closes, like Discord.
                onClick={(e) => e.target === e.currentTarget && onClose()}
              >
                <img
                  key={a.id}
                  src={url}
                  alt={a.filename}
                  decoding="async"
                  draggable={false}
                  onClick={() => setZoom((z) => !z)}
                  className={zoom ? "m-auto block max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
                />
                {many && !zoom && (
                  <>
                    <NavButton side="left" onClick={() => step(-1)} />
                    <NavButton side="right" onClick={() => step(1)} />
                  </>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      onClick={onClick}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 ${side === "left" ? "left-4" : "right-4"} -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70`}
    >
      <Icon className="size-6" />
    </button>
  );
}
