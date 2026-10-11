const urls = new Map<string, string>();

/**
 * Worklets load from a Blob URL (and WASM is inlined) because the desktop app runs from
 * file://, where fetch() and cross-file module loads are blocked.
 */
export function workletUrl(name: string, source: string): string {
  let url = urls.get(name);
  if (!url) {
    url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    urls.set(name, url);
  }
  return url;
}
