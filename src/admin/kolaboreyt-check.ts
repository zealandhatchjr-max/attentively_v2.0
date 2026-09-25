import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { KolaboreytBoard, KolaboreytClient } from "../providers/kolaboreyt.js";

/**
 * Checks the Kolaboreyt key and set-up:
 *   npm run kolaboreyt:check            → who the key is, and which boards/workspaces it can see
 *   npm run kolaboreyt:check -- --setup → also creates the "Attentively: Quotes" board and columns
 */
async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const cfg = loadConfig();
  if (!cfg.KOLABOREYT_API_KEY) throw new Error("Set KOLABOREYT_API_KEY (in .env or your secret manager).");
  const client = new KolaboreytClient({ apiKey: cfg.KOLABOREYT_API_KEY, baseUrl: cfg.KOLABOREYT_BASE_URL, minIntervalMs: cfg.KOLABOREYT_MIN_INTERVAL_MS });

  const { me } = await client.query<{ me: { id: string; name: string; email: string } }>(`query { me { id name email } }`);
  console.log(`Key works: ${me.name ?? me.email} (${me.id}).`);
  const { boards } = await client.query<{ boards: Array<{ id: string; name: string; workspace_id: string }> }>(
    `query { boards(limit: 100) { id name workspace_id } }`,
  );
  const byWs = new Map<string, string[]>();
  for (const b of boards) byWs.set(b.workspace_id, [...(byWs.get(b.workspace_id) ?? []), `${b.name} (${b.id})`]);
  console.log(`\nWorkspaces (id → boards) this key can see:`);
  for (const [ws, names] of byWs) console.log(`  ${ws}\n    ${names.join("\n    ")}`);
  if (!boards.length) console.log("  (no boards yet: find your workspace id in Kolaboreyt's URL or settings)");

  if (process.argv.includes("--setup")) {
    if (!cfg.KOLABOREYT_WORKSPACE_ID) throw new Error("Set KOLABOREYT_WORKSPACE_ID to one of the workspace ids above, then rerun with --setup.");
    const db = await openDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DATA_DIR });
    const board = new KolaboreytBoard({
      apiKey: cfg.KOLABOREYT_API_KEY,
      baseUrl: cfg.KOLABOREYT_BASE_URL,
      workspaceId: cfg.KOLABOREYT_WORKSPACE_ID,
      boardName: cfg.KOLABOREYT_BOARD_NAME,
      minIntervalMs: cfg.KOLABOREYT_MIN_INTERVAL_MS,
      db,
    });
    const s = await board.ensureSchema();
    console.log(`\nBoard ready: "${cfg.KOLABOREYT_BOARD_NAME}" (${s.boardId}), group ${s.groupId}, ${s.columns.size} columns.`);
    console.log("Set BOARD_PROVIDER=kolaboreyt to start documenting quote runs there.");
    await db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
