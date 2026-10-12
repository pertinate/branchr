import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { type Plugin, defineConfig } from "vite";

/**
 * `import url from "./x.wasm?dataurl"` → a base64 data: URL. The desktop app runs from
 * file://, where fetch() can't load files, and Vite's own `?inline` doesn't cover .wasm.
 */
function dataUrl(): Plugin {
  const suffix = "?dataurl";
  return {
    name: "dataurl",
    enforce: "pre",
    async resolveId(id, importer) {
      if (!id.endsWith(suffix)) return;
      const r = await this.resolve(id.slice(0, -suffix.length), importer, { skipSelf: true });
      return r && `\0${r.id}${suffix}`;
    },
    async load(id) {
      if (!id.startsWith("\0") || !id.endsWith(suffix)) return;
      const file = id.slice(1, -suffix.length);
      const type = file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return `export default ${JSON.stringify(`data:${type};base64,${(await readFile(file)).toString("base64")}`)};`;
    },
  };
}

export default defineConfig({
  // Relative base so the build loads from file:// inside Electron.
  base: "./",
  plugins: [dataUrl(), tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: { port: 5173, strictPort: true },
  // A second dev server (e2e on another port) needs its own pre-bundled deps.
  cacheDir: process.env.VITE_CACHE_DIR,
  build: { target: "es2023", sourcemap: false },
});
