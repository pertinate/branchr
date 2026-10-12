// Bundles the main and preload scripts to CommonJS (sandboxed preloads must be CJS).
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");

function buildOptions(development = watch) {
  return {
    entryPoints: { main: path.join(root, "src/main.ts"), preload: path.join(root, "src/preload.ts") },
    outdir: path.join(root, "dist"),
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "@vencord/venmic"],
    sourcemap: development ? "inline" : false,
    minify: !development,
    logLevel: "warning",
  };
}

export async function buildMain() {
  await build(buildOptions());
}

/** Watch both entry points and their imports; restart only after a successful build. */
export async function watchMain(onBuild) {
  const watcher = await context({
    ...buildOptions(true),
    plugins: [{
      name: "restart-electron",
      setup(builder) {
        builder.onEnd(async (result) => {
          if (!result.errors.length) await onBuild();
        });
      },
    }],
  });
  await watcher.watch();
  return watcher;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildMain();
  if (!watch) {
    // Bundle the built web client next to the main process.
    const web = path.join(root, "web");
    await rm(web, { recursive: true, force: true });
    await mkdir(web, { recursive: true });
    await cp(path.resolve(root, "../web/dist"), web, { recursive: true });
  }
}
