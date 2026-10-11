import { defineConfig } from "@playwright/test";

const SCRATCH = process.env.E2E_DATA ?? "/tmp/discord-clone-e2e";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  // Brings up the whole stack: Rust API, Rust SFU and the Vite dev server.
  webServer: [
    {
      command: `cargo run -q -p api`,
      cwd: "../..",
      url: "http://localhost:8080/api/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { DATABASE_URL: `sqlite://${SCRATCH}/db.sqlite`, API_BIND: "127.0.0.1:8080", SFU_URLS: "ws://127.0.0.1:8090/ws" },
    },
    {
      command: `cargo run -q -p sfu`,
      cwd: "../..",
      url: "http://localhost:8090/health",
      reuseExistingServer: true,
      timeout: 300_000,
      env: { SFU_PUBLIC_IP: "127.0.0.1", SFU_WORKERS: "2" },
    },
    {
      command: "pnpm --filter web dev",
      cwd: "../..",
      url: "http://localhost:5173",
      reuseExistingServer: true,
    },
  ],
});
