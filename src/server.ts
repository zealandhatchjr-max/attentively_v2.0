import { existsSync } from "node:fs";
import { loadConfig, SECRET_ENV_NAMES } from "./config.js";
import type { Ctx } from "./core/context.js";
import { openDb } from "./db/index.js";
import { buildApp } from "./http/app.js";
import { startWorker } from "./orchestrator/runner.js";
import { buildProviders } from "./providers/index.js";

/** Logger that redacts secret values if they ever end up in a log line. */
export function makeLogger(env: NodeJS.ProcessEnv = process.env) {
  const secrets = SECRET_ENV_NAMES.map((k) => env[k]).filter((v): v is string => !!v && v.length >= 6);
  const redact = (s: string) => secrets.reduce((acc, v) => acc.split(v).join("[redacted]"), s);
  return (msg: string, data?: Record<string, unknown>) =>
    console.log(redact(JSON.stringify({ t: new Date().toISOString(), msg, ...(data ?? {}) })));
}

export async function createCtx(): Promise<Ctx> {
  // Local dev convenience: load .env if present. Production injects real env vars.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const cfg = loadConfig();
  const db = await openDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DATA_DIR });
  return { db, cfg, providers: buildProviders(cfg), now: () => new Date(), log: makeLogger() };
}

async function main() {
  const ctx = await createCtx();
  const app = buildApp(ctx);
  const stop = startWorker(ctx);
  const server = app.listen(ctx.cfg.PORT, () => ctx.log("attentively.listening", { port: ctx.cfg.PORT, base: ctx.cfg.ATTENTIVELY_BASE_URL }));
  const shutdown = async () => {
    stop();
    server.close();
    await ctx.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
