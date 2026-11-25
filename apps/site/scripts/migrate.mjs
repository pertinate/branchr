// Applies migrations/*.sql in order, each once. Runs during the deploy build.
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

// Migrations want a direct connection where the pooled one is separate (e.g. Neon).
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: no DATABASE_URL; skipping");
  process.exit(0);
}
const dir = new URL("../migrations/", import.meta.url);
const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  // Held until we disconnect, so two builds never migrate at once.
  await db.query("SELECT pg_advisory_lock($1)", [0x62726d67]);
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const name of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await db.query("BEGIN");
    await db.query(await readFile(new URL(name, dir), "utf8"));
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    await db.query("COMMIT");
    console.log(`migrate: applied ${name}`);
  }
} finally {
  await db.end();
}
