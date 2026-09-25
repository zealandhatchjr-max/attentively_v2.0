import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import type { BoardItem, BoardProvider, RunHeader } from "./types.js";

/**
 * Kolaboreyt (monday.com-style board tool) adapter, via its Platform API:
 * GraphQL at POST {base}/api/v2, `Authorization: Bearer kby_live_…`, `API-Version: 2026-07`.
 *
 * Layout: one "Attentively: Quotes" board in the configured workspace. Each run is
 * an item (request) and each vendor is a subitem under it. Call transcripts are
 * comments on the vendor's subitem. Setting a run item's Status to "Resolved" in
 * Kolaboreyt resolves the run; the Platform API has no webhooks, so that is polled.
 *
 * API rules this follows: exactly one mutation root per request, each with an
 * Idempotency-Key (reused only when retrying the same logical write); pacing under
 * the 120 req/min pre-auth limit; Retry-After on 429/409.
 */

const API_VERSION = "2026-07";

export class KolaboreytError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface KolaboreytClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Minimum gap between requests (default 500ms = 120/min). */
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class KolaboreytClient {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private url: string;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: KolaboreytClientOptions) {
    this.url = `${o.baseUrl.replace(/\/+$/, "").replace(/\/api\/v2$/, "")}/api/v2`;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.send<T>(query, variables, null);
  }

  /**
   * One mutation root per call. `idempotencyKey` should be deterministic for
   * creates (so a crash-and-retry replays instead of duplicating) and unique per
   * logical write otherwise (so an identical later write isn't swallowed as a replay).
   */
  mutate<T>(query: string, variables: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const key = idempotencyKey ?? `attentively:${randomUUID()}`;
    return this.send<T>(query, variables, key);
  }

  /** Serialise requests so pacing holds across concurrent callers. */
  private send<T>(query: string, variables: Record<string, unknown>, idem: string | null): Promise<T> {
    const run = this.queue.then(() => this.sendNow<T>(query, variables, idem));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendNow<T>(query: string, variables: Record<string, unknown>, idem: string | null): Promise<T> {
    const f = this.o.fetchImpl ?? fetch;
    const maxRetries = this.o.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + (this.o.minIntervalMs ?? 500) - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();

      const res = await f(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.o.apiKey}`,
          "API-Version": API_VERSION,
          "content-type": "application/json",
          ...(idem ? { "Idempotency-Key": idem } : {}),
        },
        body: JSON.stringify({ query, variables }),
      });
      const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string; status_code?: number } }> };
      const code = body.errors?.[0]?.extensions?.code ?? (res.ok ? undefined : `HTTP_${res.status}`);

      // Retry what the API says is retryable, reusing the same Idempotency-Key.
      const retryable =
        res.status === 429 ||
        (res.status === 409 && (code === "IDEMPOTENCY_CONFLICT" || code === "IDEMPOTENCY_OUTCOME_UNKNOWN")) ||
        (res.status === 503 && (code === "IDEMPOTENCY_OUTCOME_UNKNOWN" || code === "EXECUTION_TIMEOUT"));
      if (retryable && attempt < maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(30_000, (Number.isFinite(after) && after > 0 ? after : 2 ** attempt) * 1000));
        continue;
      }
      if (body.errors?.length) {
        const e = body.errors[0];
        throw new KolaboreytError(e.extensions?.code ?? "GRAPHQL_ERROR", e.message, e.extensions?.status_code ?? res.status);
      }
      if (!res.ok) throw new KolaboreytError(code ?? "HTTP_ERROR", `Kolaboreyt request failed (${res.status})`, res.status);
      return body.data as T;
    }
  }
}

/* ---------- board layout ---------- */

type Layer = "item" | "subitem";
interface ColumnSpec {
  key: string;
  title: string;
  type: string;
  layer: Layer;
}

export const RUN_COLUMNS: ColumnSpec[] = [
  { key: "status", title: "Status", type: "pick.stage", layer: "item" },
  { key: "best_price", title: "Best price", type: "metric.amount", layer: "item" },
  { key: "best_vendor", title: "Best vendor", type: "text.line", layer: "item" },
  { key: "location", title: "Location", type: "text.line", layer: "item" },
  { key: "report", title: "Report", type: "reach.url", layer: "item" },
  { key: "updated", title: "Updated", type: "when.day", layer: "item" },
];

export const VENDOR_COLUMNS: ColumnSpec[] = [
  { key: "call_status", title: "Call status", type: "pick.stage", layer: "subitem" },
  { key: "phone", title: "Phone", type: "reach.phone", layer: "subitem" },
  { key: "price", title: "Price", type: "metric.amount", layer: "subitem" },
  { key: "negotiated", title: "Negotiated", type: "metric.amount", layer: "subitem" },
  { key: "alternative", title: "Alternative", type: "text.line", layer: "subitem" },
  { key: "promo", title: "Promo", type: "text.line", layer: "subitem" },
  { key: "earliest", title: "Earliest", type: "when.day", layer: "subitem" },
  { key: "valid_until", title: "Valid until", type: "when.day", layer: "subitem" },
  { key: "contact", title: "Contact", type: "text.line", layer: "subitem" },
  { key: "summary", title: "Summary", type: "text.prose", layer: "subitem" },
];

export const RUN_STATUS_LABELS: Record<string, string> = {
  awaiting_approval: "Awaiting approval",
  running: "Calling",
  needs_user: "Needs you",
  paused_minutes: "Paused",
  completed: "Complete",
  resolved: "Resolved",
  stopped: "Stopped",
  failed: "Failed",
};
export const RESOLVED_LABEL = "Resolved";

const VENDOR_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  calling: "Calling",
  processing: "Processing",
  done: "Done",
  needs_you: "Needs you",
  no_answer: "No answer",
  declined: "Declined",
  failed: "Failed",
  skipped: "Skipped",
};

/** Cell value as Kolaboreyt expects it for each column type (a JSON string). null = leave the cell alone. */
function cellValue(type: string, v: string | number | boolean | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  switch (type) {
    case "metric.amount":
      return typeof v === "number" && Number.isFinite(v) ? JSON.stringify(v) : null;
    case "pick.stage":
      return JSON.stringify({ label: String(v) });
    case "when.day":
      return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? JSON.stringify(String(v).slice(0, 10)) : null;
    default:
      return JSON.stringify(String(v));
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/* ---------- adapter ---------- */

export interface KolaboreytBoardOptions extends KolaboreytClientOptions {
  workspaceId: string;
  boardName: string;
  db: Db;
  now?: () => Date;
}

interface Schema {
  boardId: string;
  groupId: string;
  columns: Map<string, { id: string; spec: ColumnSpec }>; // by spec key
}

export class KolaboreytBoard implements BoardProvider {
  name = "kolaboreyt";
  readonly client: KolaboreytClient;
  private schema: Promise<Schema> | null = null;

  constructor(private o: KolaboreytBoardOptions) {
    this.client = new KolaboreytClient(o);
  }

  /* ----- refs kept in Attentively's DB so restarts never duplicate rows or comments ----- */

  private async ref(kind: string, key: string): Promise<{ external_id: string; value_hash: string | null } | null> {
    return (
      await this.o.db.query<{ external_id: string; value_hash: string | null }>(
        `SELECT external_id, value_hash FROM board_refs WHERE provider='kolaboreyt' AND kind=$1 AND key=$2`,
        [kind, key],
      )
    )[0] ?? null;
  }

  private async setRef(kind: string, key: string, externalId: string, valueHash: string | null = null) {
    await this.o.db.query(
      `INSERT INTO board_refs (provider, kind, key, external_id, value_hash) VALUES ('kolaboreyt',$1,$2,$3,$4)
       ON CONFLICT (provider, kind, key) DO UPDATE SET external_id=EXCLUDED.external_id, value_hash=EXCLUDED.value_hash`,
      [kind, key, externalId, valueHash],
    );
  }

  /** Find or create the board and every column, once per process. Idempotent against Kolaboreyt too. */
  ensureSchema(): Promise<Schema> {
    if (!this.schema) this.schema = this.loadSchema().catch((e) => ((this.schema = null), Promise.reject(e)));
    return this.schema;
  }

  private async loadSchema(): Promise<Schema> {
    const c = this.client;
    let boardId = (await this.ref("board", this.o.workspaceId))?.external_id;
    if (!boardId) {
      const { boards } = await c.query<{ boards: Array<{ id: string; name: string; workspace_id: string }> }>(
        `query { boards(limit: 100) { id name workspace_id } }`,
      );
      boardId = boards.find((b) => b.name === this.o.boardName && b.workspace_id === this.o.workspaceId)?.id;
      if (!boardId) {
        const { create_board } = await c.mutate<{ create_board: { id: string } }>(
          `mutation($ws: ID!, $name: String!, $desc: String) { create_board(workspace_id: $ws, name: $name, description: $desc) { id } }`,
          { ws: this.o.workspaceId, name: this.o.boardName, desc: "Quote runs by Attentively: one item per request, one subitem per vendor called." },
          `attentively:create-board:${this.o.workspaceId}:${sha(this.o.boardName).slice(0, 16)}`,
        );
        boardId = create_board.id;
      }
      await this.setRef("board", this.o.workspaceId, boardId);
    }

    const { boards } = await c.query<{
      boards: Array<{ groups: Array<{ id: string; title: string }>; columns: Array<{ id: string; title: string; type: string; owner_kind: string }> }>;
    }>(`query($b: ID!) { boards(ids: [$b]) { groups { id title } columns { id title type owner_kind } } }`, { b: boardId });
    const board = boards[0];
    if (!board) throw new KolaboreytError("BOARD_NOT_FOUND", `Board ${boardId} isn't readable with this key`);
    const group = board.groups[0];
    if (!group)
      throw new KolaboreytError("NO_GROUP", `Board "${this.o.boardName}" has no group. Add one in Kolaboreyt (the API can't create groups).`);

    const columns = new Map<string, { id: string; spec: ColumnSpec }>();
    for (const spec of [...RUN_COLUMNS, ...VENDOR_COLUMNS]) {
      let col = board.columns.find((x) => x.title === spec.title && x.owner_kind === spec.layer);
      if (!col) {
        const { create_column } = await c.mutate<{ create_column: { id: string; title: string; type: string; owner_kind: string } }>(
          `mutation($b: ID!, $t: String!, $type: String!, $layer: String!) { create_column(board_id: $b, title: $t, column_type: $type, owner_kind: $layer) { id title type owner_kind } }`,
          { b: boardId, t: spec.title, type: spec.type, layer: spec.layer },
          `attentively:create-column:${boardId}:${spec.layer}:${spec.key}`,
        );
        col = create_column;
      }
      columns.set(spec.key, { id: col.id, spec });
    }
    return { boardId, groupId: group.id, columns };
  }

  /** Write a cell only if its value changed since we last wrote it. */
  private async writeCell(s: Schema, itemId: string, key: string, raw: string | number | boolean | null | undefined) {
    const col = s.columns.get(key)!;
    const value = cellValue(col.spec.type, raw);
    if (value === null) return;
    const hash = sha(value);
    const refKey = `${itemId}:${col.id}`;
    if ((await this.ref("cell", refKey))?.value_hash === hash) return;
    await this.client.mutate(
      `mutation($b: ID!, $i: ID!, $c: ID!, $v: String!) { change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v, add_missing_labels: true) { column_id } }`,
      { b: s.boardId, i: itemId, c: col.id, v: value },
    );
    await this.setRef("cell", refKey, col.id, hash);
  }

  async createRun(runId: string, header: RunHeader): Promise<{ ref: string }> {
    const s = await this.ensureSchema();
    const existing = await this.ref("run", runId);
    if (existing) return { ref: existing.external_id };
    const { create_item } = await this.client.mutate<{ create_item: { id: string } }>(
      `mutation($b: ID!, $g: ID!, $n: String!) { create_item(board_id: $b, group_id: $g, item_name: $n) { id } }`,
      { b: s.boardId, g: s.groupId, n: header.title.slice(0, 250) },
      `attentively:create-run:${runId}`,
    );
    await this.setRef("run", runId, create_item.id);
    await this.updateRun(create_item.id, runId, header);
    return { ref: create_item.id };
  }

  async updateRun(ref: string, _runId: string, h: RunHeader): Promise<void> {
    const s = await this.ensureSchema();
    await this.writeCell(s, ref, "status", RUN_STATUS_LABELS[h.status] ?? h.status);
    await this.writeCell(s, ref, "best_price", h.best_price);
    await this.writeCell(s, ref, "best_vendor", h.best_vendor);
    await this.writeCell(s, ref, "location", h.location);
    await this.writeCell(s, ref, "report", h.report_url);
    await this.writeCell(s, ref, "updated", (this.o.now?.() ?? new Date()).toISOString().slice(0, 10));
  }

  async upsertVendor(ref: string, runId: string, item: BoardItem): Promise<void> {
    const s = await this.ensureSchema();
    const key = `${runId}:${item.vendorId}`;
    let subId = (await this.ref("vendor", key))?.external_id;
    if (!subId) {
      const { create_subitem } = await this.client.mutate<{ create_subitem: { id: string } }>(
        `mutation($p: ID!, $n: String!) { create_subitem(parent_item_id: $p, item_name: $n) { id } }`,
        { p: ref, n: item.name.slice(0, 250) },
        `attentively:create-vendor:${key}`,
      );
      subId = create_subitem.id;
      await this.setRef("vendor", key, subId);
    }
    await this.writeCell(s, subId, "call_status", VENDOR_STATUS_LABELS[item.status] ?? item.status);
    await this.writeCell(s, subId, "phone", item.phone);
    for (const k of ["price", "negotiated", "alternative", "promo", "earliest", "valid_until", "contact", "summary"] as const) {
      await this.writeCell(s, subId, k, item.columns[k] as string | number | null | undefined);
    }
  }

  async postCallNote(_ref: string, runId: string, vendorId: string, callId: string, text: string): Promise<void> {
    const s = await this.ensureSchema();
    if (await this.ref("note", callId)) return;
    const subId = (await this.ref("vendor", `${runId}:${vendorId}`))?.external_id;
    if (!subId) return; // vendor row not created yet; the next sync posts it
    const { add_item_update } = await this.client.mutate<{ add_item_update: { id: string } }>(
      `mutation($b: ID!, $i: ID!, $body: String!) { add_item_update(board_id: $b, item_id: $i, body: $body) { id } }`,
      { b: s.boardId, i: subId, body: text.slice(0, 10_000) },
      `attentively:call-note:${callId}`,
    );
    await this.setRef("note", callId, add_item_update.id);
  }

  async isResolved(ref: string): Promise<boolean> {
    const s = await this.ensureSchema();
    const statusCol = s.columns.get("status")!.id;
    const { items } = await this.client.query<{ items: Array<{ column_values: Array<{ column_id: string; value_json: string | null }> }> }>(
      `query($i: ID!) { items(ids: [$i]) { column_values { column_id value_json } } }`,
      { i: ref },
    );
    const cell = items[0]?.column_values.find((v) => v.column_id === statusCol);
    if (!cell?.value_json) return false;
    try {
      return (JSON.parse(cell.value_json) as { label?: string }).label === RESOLVED_LABEL;
    } catch {
      return false;
    }
  }
}
