// Puts the built web app at public/app, so it's served at /app/.
import { cp, rm } from "node:fs/promises";

const to = new URL("../public/app/", import.meta.url);
await rm(to, { recursive: true, force: true });
await cp(new URL("../../web/dist/", import.meta.url), to, { recursive: true });
// config.js comes from a route instead, so it can change without a rebuild.
await rm(new URL("config.js", to));
