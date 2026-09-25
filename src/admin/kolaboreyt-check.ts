import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { KolaboreytBoard, KolaboreytClient } from "../providers/kolaboreyt.js";
import { formatSmoke, runSmoke } from "../providers/kolaboreyt-smoke.js";

/**
 * Live check of the Kolaboreyt integration:
 *   npm run kolaboreyt:check               → steps 1–4: key, access, workspace, board + columns
 *   npm run kolaboreyt:check -- --smoke    → all 9 steps, incl. a throwaway item that's archived after
 *   npm run kolaboreyt:check -- --smoke --keep  → keep the test item to look at
 * Exit code 0 = working, 1 = not working (the FAIL line says why).
 */
async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const cfg = loadConfig({ ...process.env, BOARD_PROVIDER: "local" }); // don't require the workspace id just to run the check
  if (!cfg.KOLABOREYT_API_KEY) throw new Error("Set KOLABOREYT_API_KEY (in .env locally, or as a secret in CI).");

  const client = new KolaboreytClient({ apiKey: cfg.KOLABOREYT_API_KEY, baseUrl: cfg.KOLABOREYT_BASE_URL, minIntervalMs: cfg.KOLABOREYT_MIN_INTERVAL_MS });
  const db = await openDb({}); // throwaway: the check never touches your real database
  const board = cfg.KOLABOREYT_WORKSPACE_ID
    ? new KolaboreytBoard({
        apiKey: cfg.KOLABOREYT_API_KEY,
        baseUrl: cfg.KOLABOREYT_BASE_URL,
        workspaceId: cfg.KOLABOREYT_WORKSPACE_ID,
        boardName: cfg.KOLABOREYT_BOARD_NAME,
        minIntervalMs: cfg.KOLABOREYT_MIN_INTERVAL_MS,
        db,
      })
    : null;

  const result = await runSmoke({
    client,
    board,
    setupOnly: !process.argv.includes("--smoke"),
    keep: process.argv.includes("--keep"),
  });
  console.log(formatSmoke(result));
  await db.close();
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
