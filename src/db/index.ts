import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn inside a transaction; fn receives a Db bound to the transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

function schemaSql(): string {
  // src/db/schema.sql in dev, copied next to the build output in prod.
  for (const p of [join(here, "schema.sql"), join(here, "../../src/db/schema.sql")]) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  throw new Error("schema.sql not found");
}

export async function openDb(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  const db = opts.databaseUrl ? await openPg(opts.databaseUrl) : await openPglite(opts.pgliteDir);
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  const statements = schemaSql()
    .split(/;\s*$/m)
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);
  for (const s of statements) await db.query(s);
}

async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  // PGlite is single-connection; serialise transactions so they don't interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const run = async <T>(sql: string, params?: unknown[]) =>
    (await pg.query<T>(sql, params as unknown[])).rows;
  const db: Db = {
    query: run,
    tx: <T>(fn: (d: Db) => Promise<T>) => {
      const next = chain.then(() =>
        pg.transaction(async (t) => {
          const inner: Db = {
            query: async <R>(sql: string, params?: unknown[]) =>
              (await t.query<R>(sql, params as unknown[])).rows,
            tx: (f) => f(inner),
            close: async () => {},
          };
          return fn(inner);
        }),
      );
      chain = next.catch(() => undefined);
      return next as Promise<T>;
    },
    close: () => pg.close(),
  };
  return db;
}

async function openPg(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  const db: Db = {
    query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as T[],
    tx: async <T>(fn: (d: Db) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: Db = {
          query: async <R>(sql: string, params?: unknown[]) =>
            (await client.query(sql, params)).rows as R[],
          tx: (f) => f(inner),
          close: async () => {},
        };
        const out = await fn(inner);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}
