import { ImagePlus, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useMediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";

/** Pick a picture to upload (the server crops it), with a preview and Remove. */
export function PicturePicker(props: {
  label: string;
  url: string | null | undefined;
  shape: "circle" | "square" | "banner";
  hint?: string;
  onUpload: (file: File) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const src = useMediaUrl(props.url);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const box = props.shape === "banner" ? "h-24 w-44 rounded-md" : props.shape === "circle" ? "size-20 rounded-full" : "size-20 rounded-2xl";
  return (
    <div className="space-y-2">
      <Label>{props.label}</Label>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={cn("grid shrink-0 place-items-center overflow-hidden bg-muted text-muted-foreground hover:opacity-80", box)}
          aria-label={`Upload ${props.label.toLowerCase()}`}
        >
          {busy ? <Loader2 className="animate-spin" /> : src ? <img src={src} alt="" className="size-full object-cover" /> : <ImagePlus />}
        </button>
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
              {src ? "Change" : "Upload"}
            </Button>
            {src && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(props.onRemove)}>
                Remove
              </Button>
            )}
          </div>
          {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        data-testid={`${props.label.toLowerCase().replace(/\s+/g, "-")}-file`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(() => props.onUpload(f));
        }}
      />
    </div>
  );
}
