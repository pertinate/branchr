// Bundles the main and preload scripts to CommonJS (sandboxed preloads must be CJS).
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");

export async function buildMain() {
  await build({
    entryPoints: { main: path.join(root, "src/main.ts"), preload: path.join(root, "src/preload.ts") },
    outdir: path.join(root, "dist"),
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: watch ? "inline" : false,
    minify: !watch,
    logLevel: "warning",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildMain();
  if (!watch) {
    // Bundle the built web client next to the main process.
    const web = path.join(root, "web");
    await rm(web, { recursive: true, force: true });
    await mkdir(web, { recursive: true });
    await cp(path.resolve(root, "../web/dist"), web, { recursive: true });
  }
}
