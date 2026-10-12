// One command dev loop: Vite dev server for the UI + Electron pointed at it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { watchMain } from "./build-main.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createServer } = await import(require.resolve("vite", { paths: [path.resolve(root, "../web")] }));

// The API and SFU too, unless they're already up (or DEV_SERVERS=0).
const repo = path.resolve(root, "../..");
const backends = [];
// Also when startup fails below (e.g. Vite's port is taken).
process.on("exit", () => {
  for (const p of backends) p.kill("SIGTERM");
});
async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
async function ensureBackend(name, health, env, extra = []) {
  if (process.env.DEV_SERVERS === "0" || (await up(health))) return;
  console.log(`[dev] starting ${name} (cargo run -p ${name})`);
  const p = spawn("cargo", ["run", "-q", "-p", name, ...extra], { cwd: repo, stdio: "inherit", env: { ...process.env, ...env } });
  backends.push(p);
  for (let i = 0; i < 600 && p.exitCode === null; i++) {
    if (await up(health)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[dev] ${name} didn't come up; check the output above`);
}
// branchr ID with real Discord sign-in, from ~/.config/branchr/id.env (DISCORD_CLIENT_ID,
// DISCORD_CLIENT_SECRET, DATABASE_URL; see scripts/dev-id.sh). Without it, password accounts only.
function idEnv() {
  const file = process.env.BRANCHR_ID_ENV ?? path.join(os.homedir(), ".config/branchr/id.env");
  if (!existsSync(file)) return null;
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !line.startsWith("#")) env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return env.DISCORD_CLIENT_ID && env.DATABASE_URL ? env : null;
}
const id = idEnv();
if (id) {
  await ensureBackend("id", "http://localhost:8070/health", {
    ...id,
    ID_BIND: "127.0.0.1:8070",
    PUBLIC_URL: "http://localhost:8070",
    ALLOWED_REDIRECTS: "branchr://auth/callback,http://localhost:5173/",
  }, ["--bin", "branchr-id"]);
} else {
  console.log("[dev] no ~/.config/branchr/id.env: Discord sign-in is off (password accounts only)");
}
await Promise.all([
  ensureBackend(
    "api",
    "http://localhost:8080/api/health",
    id
      ? {
          // Discord (through branchr ID) first, server accounts still allowed.
          AUTH_MODE: "both",
          BRANCHR_ID_URL: "http://localhost:8070",
          PUBLIC_URL: "http://localhost:8080",
          INSTANCE_NAME: "dev",
          CLAIM_FILE: path.join(repo, "data/claim-code.txt"),
        }
      : {},
  ),
  ensureBackend("sfu", "http://localhost:8090/health", { SFU_PUBLIC_IP: process.env.SFU_PUBLIC_IP ?? "127.0.0.1" }),
]);

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
