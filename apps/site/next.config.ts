import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // The web app's asset paths are relative, so it has to live at /app/ with the slash.
  skipTrailingSlashRedirect: true,
  rewrites: async () => [{ source: "/app/", destination: "/app/index.html" }],
  headers: async () => [{ source: "/app/assets/:file*", headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }] }],
};

export default config;
