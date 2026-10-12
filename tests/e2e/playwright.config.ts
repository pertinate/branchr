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
/** E2E_INSTANCE_DB=postgres runs the main instance on Postgres (TEST_DATABASE_URL) instead of SQLite. */
const instanceOnPostgres = process.env.E2E_INSTANCE_DB === "postgres";
if (instanceOnPostgres && !idDb) throw new Error("E2E_INSTANCE_DB=postgres needs TEST_DATABASE_URL");
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
      env: {
        DATABASE_URL: instanceOnPostgres ? idDb! : `sqlite://${SCRATCH}/db.sqlite`,
        ...(instanceOnPostgres ? { DATABASE_SCHEMA: "e2e_instance", UPLOAD_DIR: `${SCRATCH}/uploads` } : {}),
        API_BIND: "127.0.0.1:8080",
        SFU_URLS: "ws://127.0.0.1:8090/ws",
        MAX_UPLOAD_MB: "1",
        EMOTE_PROVIDERS_URL: "http://localhost:8072",
        // With branchr ID around, this host takes branchr accounts too (password logins still work).
        ...(idDb
          ? { AUTH_MODE: "both", BRANCHR_ID_URL: "http://localhost:8070", INSTANCE_NAME: "e2e home", PUBLIC_URL: "http://localhost:8080", CLAIM_FILE: `${SCRATCH}/claim-code.txt`, BRANCHR_POLL_SECS: "1" }
          : {}),
      },
    },
    {
      command: `cargo run -q -p sfu`,
      cwd: "../..",
      url: "http://localhost:8090/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { SFU_PUBLIC_IP: "127.0.0.1", SFU_WORKERS: "2" },
    },
    // 7TV / FrankerFaceZ / BetterTTV stand-in.
    { command: "node mock-emotes.mjs", url: "http://localhost:8072/health", reuseExistingServer: true },
    // A second instance (multi-instance tests); with branchr ID around it also accepts branchr accounts.
    {
      command: "cargo run -q -p api",
      cwd: "../..",
      url: "http://localhost:8081/api/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: {
        DATABASE_URL: `sqlite://${fedDir}/db.sqlite`,
        API_BIND: "127.0.0.1:8081",
        EMOTE_PROVIDERS_URL: "http://localhost:8072",
        SFU_URLS: "ws://127.0.0.1:8090/ws",
        ...(idDb
          ? {
              AUTH_MODE: "both",
              BRANCHR_ID_URL: "http://localhost:8070",
              INSTANCE_NAME: "e2e federated",
              PUBLIC_URL: "http://localhost:8081",
              CLAIM_FILE: `${fedDir}/claim-code.txt`,
              BRANCHR_POLL_SECS: "1",
            }
          : {}),
      },
    },
    ...(idDb
      ? [
          { command: "node mock-discord.mjs", url: "http://localhost:8071/health", reuseExistingServer: true },
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
