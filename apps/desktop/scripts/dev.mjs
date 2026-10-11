// One command dev loop: Vite dev server for the UI + Electron pointed at it.
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

import { buildMain } from "./build-main.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createServer } = await import(require.resolve("vite", { paths: [path.resolve(root, "../web")] }));

const server = await createServer({ root: path.resolve(root, "../web"), configFile: path.resolve(root, "../web/vite.config.ts") });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] vite at ${url}`);

await buildMain();
const electron = require("electron");
const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, DEV_URL: url } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
