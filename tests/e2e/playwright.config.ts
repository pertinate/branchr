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
/**
 * E2E_S3_ENDPOINT (+ E2E_S3_ACCESS_KEY / E2E_S3_SECRET_KEY) stores the main instance's files in
 * an S3 bucket (rustfs in CI) instead of on disk; downloads redirect to signed bucket URLs.
 */
const s3 = process.env.E2E_S3_ENDPOINT;
/** Fresh each run, so the federated server registers and gets claimed anew. Tests read it. */
process.env.E2E_FEDERATED_DIR ??= `${SCRATCH}/federated-${Date.now().toString(36)}`;
const fedDir = process.env.E2E_FEDERATED_DIR;
/** The gateway that admits hubs by their branchr key (relay-key.spec); branchr ID reads its certificate. */
process.env.E2E_RELAY_KEY_DIR ??= `${SCRATCH}/relay-key`;
const relayKeyDir = process.env.E2E_RELAY_KEY_DIR;
/**
 * Everything here runs on its own ports (18xxx, UDP 51000+) and the web client with its own
 * Vite cache, so a test run sits next to `pnpm dev` (8070/8080/8090, 5173) without touching it.
 */
const webPort = process.env.E2E_WEB_PORT ?? "15173";
const web = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // CI machines are slower and noisier; a second try is reported as flaky, not hidden.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: remote ?? web,
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
      url: "http://localhost:18080/api/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: {
        DATABASE_URL: instanceOnPostgres ? idDb! : `sqlite://${SCRATCH}/db.sqlite`,
        ...(instanceOnPostgres ? { DATABASE_SCHEMA: "e2e_instance" } : {}),
        ...(s3
          ? {
              S3_ENDPOINT: s3,
              S3_PUBLIC_URL: s3,
              S3_BUCKET: "branchr-e2e",
              S3_ACCESS_KEY: process.env.E2E_S3_ACCESS_KEY ?? "",
              S3_SECRET_KEY: process.env.E2E_S3_SECRET_KEY ?? "",
            }
          : { UPLOAD_DIR: `${SCRATCH}/uploads` }),
        API_BIND: "127.0.0.1:18080",
        SFU_URLS: "ws://127.0.0.1:18090/ws",
        MAX_UPLOAD_MB: "1",
        EMOTE_PROVIDERS_URL: "http://localhost:18072",
        // Link previews of the mock pages on localhost.
        EMBED_ALLOW_PRIVATE: "1",
        // With branchr ID around, this host takes branchr accounts too (password logins still work).
        ...(idDb
          ? { AUTH_MODE: "both", BRANCHR_ID_URL: "http://localhost:18070", INSTANCE_NAME: "e2e home", PUBLIC_URL: "http://localhost:18080", CLAIM_FILE: `${SCRATCH}/claim-code.txt`, BRANCHR_POLL_SECS: "1" }
          : {}),
      },
    },
    {
      command: `cargo run -q -p sfu`,
      cwd: "../..",
      url: "http://localhost:18090/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { SFU_BIND: "127.0.0.1:18090", SFU_UDP_PORT: "51000", SFU_PUBLIC_IP: "127.0.0.1", SFU_WORKERS: "2" },
    },
    // 7TV / FrankerFaceZ / BetterTTV stand-in.
    { command: "node mock-emotes.mjs", url: "http://localhost:18072/health", reuseExistingServer: true },
    // A second instance (multi-instance tests); with branchr ID around it also accepts branchr accounts.
    {
      command: "cargo run -q -p api",
      cwd: "../..",
      url: "http://localhost:18081/api/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: {
        DATABASE_URL: `sqlite://${fedDir}/db.sqlite`,
        API_BIND: "127.0.0.1:18081",
        EMOTE_PROVIDERS_URL: "http://localhost:18072",
        SFU_URLS: "ws://127.0.0.1:18090/ws",
        ...(idDb
          ? {
              AUTH_MODE: "both",
              BRANCHR_ID_URL: "http://localhost:18070",
              INSTANCE_NAME: "e2e federated",
              PUBLIC_URL: "http://localhost:18081",
              CLAIM_FILE: `${fedDir}/claim-code.txt`,
              BRANCHR_POLL_SECS: "1",
            }
          : {}),
      },
    },
    ...(idDb
      ? [
          { command: "node mock-discord.mjs", url: "http://localhost:18071/health", reuseExistingServer: true },
          // branchr ID's own SFU, for DM calls (its own secret and ports).
          {
            command: "cargo run -q -p sfu",
            cwd: "../..",
            url: "http://localhost:18091/health",
            reuseExistingServer: true,
            timeout: 300_000,
            env: { SFU_BIND: "127.0.0.1:18091", SFU_UDP_PORT: "51100", SFU_WORKERS: "1", SFU_PUBLIC_IP: "127.0.0.1", VOICE_SECRET: "e2e-id-voice" },
          },
          {
            command: "cargo run -q -p id --bin branchr-id",
            cwd: "../..",
            url: "http://localhost:18070/health",
            reuseExistingServer: true,
            timeout: 300_000,
            env: {
              DATABASE_URL: idDb,
              DATABASE_SCHEMA: "e2e",
              ID_BIND: "127.0.0.1:18070",
              PUBLIC_URL: "http://localhost:18070",
              DISCORD_CLIENT_ID: "e2e",
              DISCORD_CLIENT_SECRET: "e2e",
              DISCORD_API: "http://localhost:18071/api",
              DISCORD_AUTHORIZE: "http://localhost:18071/oauth2/authorize",
              ALLOWED_REDIRECTS: `branchr://auth/callback,${web}/`,
              ID_SFU_URL: "ws://127.0.0.1:18091/ws",
              // The gateway hubs can be reached through (relay-key-stack.sh).
              RELAY_QUIC: "127.0.0.1:17543",
              RELAY_CERT: `${relayKeyDir}/gateway/cert.der`,
              RELAY_WEB: "http://localhost:18900",
              ID_VOICE_SECRET: "e2e-id-voice",
            },
          },
          // A hub reached through a gateway by its branchr key (relay-key.spec).
          { command: "./relay-key-stack.sh", url: "http://127.0.0.1:18280/api/health", reuseExistingServer: true, timeout: 300_000 },
        ]
      : []),
    // A hub reached only through branchr-relay (relay-gateway.spec).
    { command: "./relay-stack.sh", url: "http://127.0.0.1:18800/_relay/check?domain=relayed.localhost&connected", reuseExistingServer: true, timeout: 300_000 },
    {
      command: `pnpm --filter web dev --port ${webPort}`,
      cwd: "../..",
      url: web,
      reuseExistingServer: true,
      // Logins default to this run's host and branchr ID, not the dev ones.
      env: { VITE_CACHE_DIR: "node_modules/.vite-e2e", VITE_DEFAULT_SERVER: "http://localhost:18080", VITE_BRANCHR_ID_URL: "http://localhost:18070" },
    },
  ],
});
