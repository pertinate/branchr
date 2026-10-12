// One command dev loop: Vite dev server for the UI + Electron pointed at it.
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

import { watchMain } from "./build-main.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createServer } = await import(require.resolve("vite", { paths: [path.resolve(root, "../web")] }));

const server = await createServer({ root: path.resolve(root, "../web"), configFile: path.resolve(root, "../web/vite.config.ts") });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] vite at ${url}`);

const electron = require("electron");
let child;
let watcher;
let stopping = false;

async function stopElectron() {
  const previous = child;
  child = undefined;
  if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => previous.kill("SIGKILL"), 5000);
    previous.once("exit", () => { clearTimeout(timer); resolve(); });
    previous.kill("SIGTERM");
  });
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await stopElectron();
  await watcher?.dispose();
  await server.close();
  process.exit(code);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

watcher = await watchMain(async () => {
  if (stopping) return;
  const restarting = !!child;
  await stopElectron();
  if (stopping) return;
  console.log(`[dev] ${restarting ? "restarting" : "starting"} Electron`);
  const next = spawn(electron, [root, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, DEV_URL: url },
  });
  child = next;
  next.on("exit", (code) => {
    // Intentional restarts clear child before stopping the old process.
    if (child === next) void shutdown(code ?? 0);
  });
  next.on("error", (error) => {
    console.error(`[dev] Electron: ${error.message}`);
    void shutdown(1);
  });
});
