import { defineConfig } from "@playwright/test";

const SCRATCH = process.env.E2E_DATA ?? "/tmp/branchr-e2e";
/**
 * Point at a deployed instance instead of a local stack. Media APIs need a secure context, so
 * for a plain-http LAN deployment tunnel it to localhost first:
 *   ssh -NL 18740:localhost:8740 root@host & E2E_BASE_URL=http://localhost:18740 pnpm test
 */
const remote = process.env.E2E_BASE_URL;
/** branchr ID needs Postgres; its tests skip without one. */
const idDb = process.env.TEST_DATABASE_URL;
/** Fresh each run, so the federated server registers and gets claimed anew. Tests read it. */
process.env.E2E_FEDERATED_DIR ??= `${SCRATCH}/federated-${Date.now().toString(36)}`;
const fedDir = process.env.E2E_FEDERATED_DIR;

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: remote ?? "http://localhost:5173",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  // Brings up the whole stack: Rust API, Rust SFU and the Vite dev server.
  webServer: remote ? [] : [
    {
      command: `cargo run -q -p api`,
      cwd: "../..",
      url: "http://localhost:8080/api/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { DATABASE_URL: `sqlite://${SCRATCH}/db.sqlite`, API_BIND: "127.0.0.1:8080", SFU_URLS: "ws://127.0.0.1:8090/ws", MAX_UPLOAD_MB: "1" },
    },
    {
      command: `cargo run -q -p sfu`,
      cwd: "../..",
      url: "http://localhost:8090/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { SFU_PUBLIC_IP: "127.0.0.1", SFU_WORKERS: "2" },
    },
    ...(idDb
      ? [
          { command: "node mock-discord.mjs", url: "http://localhost:8071/health", reuseExistingServer: true },
          // A second server that accepts branchr accounts (and its own).
          {
            command: "cargo run -q -p api",
            cwd: "../..",
            url: "http://localhost:8081/api/health",
            reuseExistingServer: true,
            timeout: 300_000,
            env: {
              DATABASE_URL: `sqlite://${fedDir}/db.sqlite`,
              API_BIND: "127.0.0.1:8081",
              SFU_URLS: "ws://127.0.0.1:8090/ws",
              AUTH_MODE: "both",
              BRANCHR_ID_URL: "http://localhost:8070",
              INSTANCE_NAME: "e2e federated",
              CLAIM_FILE: `${fedDir}/claim-code.txt`,
              BRANCHR_POLL_SECS: "1",
            },
          },
          {
            command: "cargo run -q -p id --bin branchr-id",
            cwd: "../..",
            url: "http://localhost:8070/health",
            reuseExistingServer: true,
            timeout: 300_000,
            env: {
              DATABASE_URL: idDb,
              DATABASE_SCHEMA: "e2e",
              ID_BIND: "127.0.0.1:8070",
              PUBLIC_URL: "http://localhost:8070",
              DISCORD_CLIENT_ID: "e2e",
              DISCORD_CLIENT_SECRET: "e2e",
              DISCORD_API: "http://localhost:8071/api",
              DISCORD_AUTHORIZE: "http://localhost:8071/oauth2/authorize",
              ALLOWED_REDIRECTS: "branchr://auth/callback,http://localhost:5173/",
            },
          },
        ]
      : []),
    {
      command: "pnpm --filter web dev",
      cwd: "../..",
      url: "http://localhost:5173",
      reuseExistingServer: true,
    },
  ],
});
