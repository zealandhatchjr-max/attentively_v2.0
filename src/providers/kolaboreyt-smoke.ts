import { KolaboreytBoard, KolaboreytClient, KolaboreytError, RESOLVED_LABEL } from "./kolaboreyt.js";

/**
 * Live end-to-end check of the Kolaboreyt integration, step by step, using the
 * same code paths production uses. Prints a pass/fail table and stops at the
 * first hard failure with a plain-English fix.
 */

export interface SmokeStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface SmokeResult {
  ok: boolean;
  steps: SmokeStep[];
  workspaces?: Array<{ id: string; boards: string[] }>;
}

/** Turn any failure into advice a non-developer can act on. */
export function explain(e: unknown): string {
  if (e instanceof KolaboreytError) {
    switch (e.code) {
      case "UNAUTHORIZED":
        return "The API key was rejected (wrong, revoked or expired). Create a new key under Settings → Developers.";
      case "MISSING_SCOPE":
        return `The key is missing the "${String(e.details.required_scope ?? "?")}" permission. Re-issue it with boards:read, boards:write, columns:write, items:read, items:write.`;
      case "API_KEY_POLICY_DENIED":
        return "That Kolaboreyt account's security policy blocks write access for personal keys. Use a service-account key, or relax the policy.";
      case "QUOTA_EXCEEDED":
        return "The account has hit its active-boards limit. Archive a board or upgrade the plan.";
      case "FEATURE_NOT_AVAILABLE":
        return "This needs a plan feature the account doesn't have.";
      case "GUEST_CANNOT_CREATE_BOARD":
        return "The key's owner is only a guest in that workspace's account, so it can't create boards there.";
      case "NOT_FOUND":
        return "Not found, or not visible to this key. Check KOLABOREYT_WORKSPACE_ID and that the key's owner is a member there.";
      case "FORBIDDEN":
        return `The key's owner lacks permission (${String(e.details.required_permission ?? "unknown")}) on that board or workspace.`;
      case "NO_GROUP":
        return e.message.replace(/^NO_GROUP: /, "");
      case "NETWORK_BLOCKED":
        return `${e.message.replace(/^NETWORK_BLOCKED: /, "")}. The network this runs on is blocking api.kolaboreyt.com: allow that host (or run the check from GitHub Actions or your own computer).`;
      case "RATE_LIMIT_EXCEEDED":
        return "Rate-limited even after retries. Try again in a minute.";
      case "API_VERSION_REQUIRED":
      case "INVALID_VERSION":
        return "The API version header was rejected. Kolaboreyt may have moved past 2026-07; check the docs for the current version.";
      default:
        return e.message;
    }
  }
  const msg = String((e as Error)?.message ?? e);
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|CONNECT|403|tunnel/i.test(msg) || /fetch failed/.test(String((e as Error)?.cause ?? "")))
    return `Couldn't reach Kolaboreyt (${msg}). If this runs in a locked-down network, allow api.kolaboreyt.com.`;
  return msg;
}

interface ExpectedCell {
  column: string;
  layer: "item" | "subitem";
  check: (stored: unknown) => boolean;
  shows: string;
}

export async function runSmoke(opts: {
  client: KolaboreytClient;
  board: KolaboreytBoard | null; // null when no workspace is configured yet
  keep?: boolean;
  /** Stop after the board set-up (step 4): no test item is written. */
  setupOnly?: boolean;
}): Promise<SmokeResult> {
  const steps: SmokeStep[] = [];
  const { client, board } = opts;
  const pass = (step: string, detail: string) => steps.push({ step, ok: true, detail });
  const fail = (step: string, e: unknown): SmokeResult => {
    steps.push({ step, ok: false, detail: explain(e) });
    return { ok: false, steps };
  };

  // 1. Reach + auth
  try {
    const { me } = await client.query<{ me: { id: string; name: string | null; email: string | null } }>(`query { me { id name email } }`);
    pass("1. Reach + auth", `Key belongs to ${me.name ?? me.email ?? me.id}`);
  } catch (e) {
    return fail("1. Reach + auth", e);
  }

  // 2 + 3. Read scope, and the workspaces this key can see
  let workspaces: Array<{ id: string; boards: string[] }> = [];
  try {
    const { boards } = await client.query<{ boards: Array<{ id: string; name: string; workspace_id: string }> }>(
      `query { boards(limit: 100) { id name workspace_id } }`,
    );
    const map = new Map<string, string[]>();
    for (const b of boards) map.set(b.workspace_id, [...(map.get(b.workspace_id) ?? []), `${b.name} (${b.id})`]);
    workspaces = [...map].map(([id, names]) => ({ id, boards: names }));
    pass("2. Read access", `Can read ${boards.length} board(s) across ${workspaces.length} workspace(s)`);
  } catch (e) {
    return fail("2. Read access", e);
  }
  if (!board) {
    steps.push({
      step: "3. Workspace",
      ok: false,
      detail: workspaces.length
        ? "Set KOLABOREYT_WORKSPACE_ID to one of the workspace ids listed below, then run again."
        : "The key can't see any boards yet. Find the workspace id in Kolaboreyt (URL or settings) and set KOLABOREYT_WORKSPACE_ID.",
    });
    return { ok: false, steps, workspaces };
  }
  pass("3. Workspace", "KOLABOREYT_WORKSPACE_ID is set");

  // 4. Board, group, columns (create or find)
  try {
    const s = await board.ensureSchema();
    pass("4. Board + columns", `Board ${s.boardId}, group ${s.groupId}, ${s.columns.size} columns ready`);
  } catch (e) {
    return fail("4. Board + columns", e);
  }
  if (opts.setupOnly) return { ok: true, steps };

  // 5. Write path, through the same methods real runs use
  const runId = `smoke-${Date.now()}`;
  let ref: string;
  const today = new Date().toISOString().slice(0, 10);
  const header = {
    title: `Attentively smoke test ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    status: "running",
    location: "Robina, Gold Coast QLD",
    best_price: 620,
    best_vendor: "Smoke Test Tyres",
    report_url: "https://example.com/attentively-smoke",
  };
  const vendor = {
    vendorId: "smoke-vendor",
    name: "Smoke Test Tyres",
    phone: "+61755550100",
    status: "done",
    columns: {
      price: 660,
      negotiated: 620,
      alternative: "Hankook Ventus Prime 4 $520",
      promo: "Buy 4 get $50 gift card",
      earliest: today,
      valid_until: today,
      contact: "Dave",
      summary: "Smoke test: in stock, $660 fitted, negotiated to $620.",
    },
  };
  try {
    ref = (await board.createRun(runId, header)).ref;
    await board.upsertVendor(ref, runId, vendor);
    await board.postCallNote(ref, runId, vendor.vendorId, `${runId}-call`, "📞 Smoke test call\nMaddie: Hi, I'm Maddie…\nDave: Sure, Dave here.");
    pass("5. Write path", `Created item ${ref} with a vendor subitem, wrote every column type, posted a comment`);
  } catch (e) {
    return fail("5. Write path", e);
  }

  // 6. Read back and compare with the documented stored shapes
  try {
    const s = await board.ensureSchema();
    const colId = (title: string, layer: "item" | "subitem") => [...s.columns.values()].find((c) => c.spec.title === title && c.spec.layer === layer)!.id;
    const [item] = (await client.query<{ items: Array<{ column_values: Array<{ column_id: string; value_json: string | null }> }> }>(
      `query($ids: [ID!]!) { items(ids: $ids) { column_values { column_id value_json } } }`,
      { ids: [ref] },
    )).items;
    const { list_subitems } = await client.query<{ list_subitems: Array<{ name: string; column_values: Array<{ column_id: string; value_json: string | null }> }> }>(
      `query($p: ID!) { list_subitems(parent_item_id: $p) { name column_values { column_id value_json } } }`,
      { p: ref },
    );
    const sub = list_subitems.find((x) => x.name === vendor.name);
    if (!item || !sub) throw new Error("Couldn't read the test item or its vendor subitem back.");

    const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
    const expected: ExpectedCell[] = [
      { column: "Status", layer: "item", check: (v) => obj(v).label === "Calling", shows: '{label:"Calling"}' },
      { column: "Best price", layer: "item", check: (v) => v === 620, shows: "620" },
      { column: "Best vendor", layer: "item", check: (v) => v === "Smoke Test Tyres", shows: '"Smoke Test Tyres"' },
      { column: "Report", layer: "item", check: (v) => obj(v).href === header.report_url || v === header.report_url, shows: "{href}" },
      { column: "Updated", layer: "item", check: (v) => obj(v).date === today || v === today, shows: "{date}" },
      { column: "Call status", layer: "subitem", check: (v) => obj(v).label === "Done", shows: '{label:"Done"}' },
      { column: "Phone", layer: "subitem", check: (v) => String(obj(v).number ?? v).replace(/\D/g, "").endsWith("755550100"), shows: "{number}" },
      { column: "Price", layer: "subitem", check: (v) => v === 660, shows: "660" },
      { column: "Earliest", layer: "subitem", check: (v) => obj(v).date === today || v === today, shows: "{date}" },
      { column: "Summary", layer: "subitem", check: (v) => typeof v === "string" && v.includes("Smoke test"), shows: "text" },
    ];
    const mismatches: string[] = [];
    for (const x of expected) {
      const row = x.layer === "item" ? item : sub;
      const cell = row.column_values.find((c) => c.column_id === colId(x.column, x.layer));
      const stored = cell?.value_json ? JSON.parse(cell.value_json) : undefined;
      if (!x.check(stored)) mismatches.push(`${x.column}: expected ${x.shows}, got ${cell?.value_json ?? "nothing"}`);
    }
    if (mismatches.length) {
      steps.push({ step: "6. Read-back", ok: false, detail: `Stored values differ from the docs: ${mismatches.join("; ")}` });
      return { ok: false, steps };
    }
    pass("6. Read-back", `All ${expected.length} checked cells read back in the documented shape`);
  } catch (e) {
    return fail("6. Read-back", e);
  }

  // 7. Resolved: set on the board, detected by Attentively
  try {
    const s = await board.ensureSchema();
    await client.mutate(
      `mutation($b: ID!, $i: ID!, $c: ID!, $v: String!) { change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v, add_missing_labels: true) { column_id } }`,
      { b: s.boardId, i: ref, c: s.columns.get("status")!.id, v: JSON.stringify({ label: RESOLVED_LABEL }) },
    );
    if (!(await board.isResolved(ref))) throw new Error("Status was set to Resolved but Attentively didn't detect it.");
    pass("7. Resolved", "Setting Status to Resolved on the board is detected");
  } catch (e) {
    return fail("7. Resolved", e);
  }

  // 8. Idempotency: the same key + body must replay, not duplicate
  try {
    const s = await board.ensureSchema();
    const key = `attentively:smoke-replay:${runId}`;
    const doc = `mutation($b: ID!, $i: ID!, $body: String!) { add_item_update(board_id: $b, item_id: $i, body: $body) { id } }`;
    const vars = { b: s.boardId, i: ref, body: "Idempotency replay check" };
    const first = await client.mutate<{ add_item_update: { id: string } }>(doc, vars, key);
    const second = await client.mutate<{ add_item_update: { id: string } }>(doc, vars, key);
    const replayed = client.lastHeaders?.get("idempotency-replayed") === "true";
    if (first.add_item_update.id !== second.add_item_update.id)
      throw new Error("Replaying the same Idempotency-Key created a second comment.");
    pass("8. Idempotency", replayed ? "Replay returned the original result (Idempotency-Replayed: true)" : "Replay returned the original result");
  } catch (e) {
    return fail("8. Idempotency", e);
  }

  // 9. Clean-up
  if (opts.keep) {
    pass("9. Clean-up", `Kept the test item ${ref} for you to look at (--keep)`);
  } else {
    try {
      await board.archiveRun(ref);
      pass("9. Clean-up", "Archived the test item and its subitem");
    } catch (e) {
      return fail("9. Clean-up", e);
    }
  }
  return { ok: true, steps };
}

export function formatSmoke(r: SmokeResult): string {
  const lines = r.steps.map((s) => `${s.ok ? "PASS" : "FAIL"}  ${s.step.padEnd(22)} ${s.detail}`);
  if (r.workspaces?.length) {
    lines.push("", "Workspaces this key can see:");
    for (const w of r.workspaces) lines.push(`  ${w.id}`, ...w.boards.map((b) => `    ${b}`));
  }
  lines.push("", r.ok ? "Kolaboreyt integration: WORKING" : "Kolaboreyt integration: NOT WORKING YET (see the FAIL line above)");
  return lines.join("\n");
}
