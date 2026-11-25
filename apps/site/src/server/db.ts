import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { OAuthError } from "./http";

// One small pool per function instance; use the database's pooled connection string.
const globals = globalThis as { branchrPool?: Pool };

function pool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new OAuthError(503, "server_error", "no database is set up");
  return (globals.branchrPool ??= new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000 }));
}

export async function query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool().query<T>(sql, values)).rows;
}

export async function transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await run(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
