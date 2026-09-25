import { readFileSync } from "node:fs";
import {
  buildSchema,
  getVariableValues,
  Kind,
  parse,
  validate,
  type OperationDefinitionNode,
} from "graphql";
import { afterEach, describe, expect, it } from "vitest";
import * as store from "../src/core/store.js";
import { RunStatus } from "../src/core/types.js";
import type { Db } from "../src/db/index.js";
import { openDb } from "../src/db/index.js";
import { advanceRun, approvePlan, pollBoardResolved } from "../src/orchestrator/runner.js";
import { KolaboreytBoard, KolaboreytClient } from "../src/providers/kolaboreyt.js";
import { explain, runSmoke } from "../src/providers/kolaboreyt-smoke.js";
import { FakeKolaboreyt } from "./fakes/kolaboreyt.js";
import { makeCtx, planTyreRun } from "./helpers.js";

/** The Platform API schema, copied verbatim from the Kolaboreyt API docs. */
const schema = buildSchema(readFileSync(new URL("./fixtures/kolaboreyt-schema.graphql", import.meta.url), "utf8"));

/** Validate one request exactly as a GraphQL server would, against the documented schema. */
function contractErrors(query: string, variables: Record<string, unknown>): string[] {
  const doc = parse(query);
  const errors = validate(schema, doc).map((e) => e.message);
  const ops = doc.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
  if (ops.length !== 1) errors.push(`expected 1 operation, got ${ops.length}`);
  const op = ops[0];
  if (op.operation === "mutation" && op.selectionSet.selections.length !== 1)
    errors.push(`mutation selects ${op.selectionSet.selections.length} root fields (Kolaboreyt allows exactly 1)`);
  const coerced = getVariableValues(schema, op.variableDefinitions ?? [], variables);
  if (coerced.errors) errors.push(...coerced.errors.map((e) => e.message));
  return errors;
}

let dbs: Db[] = [];
afterEach(async () => {
  for (const d of dbs) await d.close();
  dbs = [];
});

function boardFor(fake: FakeKolaboreyt, db: Db, workspaceId = "ws_1") {
  return new KolaboreytBoard({
    apiKey: "kby_test_key",
    baseUrl: "https://api.kolaboreyt.test",
    workspaceId,
    boardName: "Attentively: Quotes",
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: fake.fetch as typeof fetch,
    db,
  });
}

describe("Kolaboreyt API contract (documented schema)", () => {
  it("the schema file is the documented Platform API", () => {
    const m = schema.getMutationType()!.getFields();
    expect(Object.keys(m)).toEqual(expect.arrayContaining(["create_board", "create_column", "create_item", "create_subitem", "change_column_value", "add_item_update", "archive_item"]));
    expect(m.change_column_value.args.map((a) => a.name)).toContain("add_missing_labels");
  });

  it("every request a full quote run sends is valid against the schema", async () => {
    const t = await makeCtx();
    dbs.push(t.db);
    const fake = new FakeKolaboreyt();
    t.ctx.providers.board = boardFor(fake, t.db);
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto", "Varsity Tyrepower", "Burleigh Wheel Centre"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    for (let i = 0; i < 40; i++) {
      t.clock.now = new Date(t.clock.now.getTime() + 20_000);
      await advanceRun(t.ctx, plan.run_id);
      const s = (await store.getRun(t.db, plan.run_id))!.status;
      if (s === RunStatus.NeedsUser) {
        // skip the question so the run completes
        t.clock.now = new Date(t.clock.now.getTime() + 3 * 3600_000);
        await store.scheduleRun(t.db, plan.run_id, t.clock.now);
      }
      if (s === RunStatus.Completed) break;
    }
    await pollBoardResolved(t.ctx);

    expect(fake.requests.length).toBeGreaterThan(20);
    const failures = fake.requests
      .map((r) => ({ q: r.query.replace(/\s+/g, " ").slice(0, 90), errors: contractErrors(r.query, r.variables) }))
      .filter((x) => x.errors.length);
    expect(failures).toEqual([]);
    // every column type we write was accepted by the documented normaliser
    expect(fake.columns.map((c) => c.type)).toEqual(expect.arrayContaining(["pick.stage", "metric.amount", "text.line", "reach.url", "when.day", "reach.phone", "text.prose"]));
  });

  it("the live smoke test passes end to end against the strict fake, and all its requests are valid", async () => {
    const fake = new FakeKolaboreyt();
    const db = await openDb({});
    dbs.push(db);
    const client = new KolaboreytClient({ apiKey: "kby_test_key", baseUrl: "https://api.kolaboreyt.test", minIntervalMs: 0, fetchImpl: fake.fetch as typeof fetch });
    const r = await runSmoke({ client, board: boardFor(fake, db) });
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(9);
    expect([...fake.items.values()].every((i) => i.state === "archived")).toBe(true); // cleaned up
    const bad = fake.requests.map((x) => contractErrors(x.query, x.variables)).filter((e) => e.length);
    expect(bad).toEqual([]);
  });

  it("setup-only mode never writes a test item", async () => {
    const fake = new FakeKolaboreyt();
    const db = await openDb({});
    dbs.push(db);
    const client = new KolaboreytClient({ apiKey: "k", baseUrl: "https://x.test", minIntervalMs: 0, fetchImpl: fake.fetch as typeof fetch });
    const r = await runSmoke({ client, board: boardFor(fake, db), setupOnly: true });
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(4);
    expect(fake.items.size).toBe(0);
  });

  it("explains failures in plain English", async () => {
    const fake = new FakeKolaboreyt();
    const db = await openDb({});
    dbs.push(db);
    const client = new KolaboreytClient({ apiKey: "k", baseUrl: "https://x.test", minIntervalMs: 0, fetchImpl: fake.fetch as typeof fetch });

    fake.scopes.delete("columns:write");
    const r = await runSmoke({ client, board: boardFor(fake, db) });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.step).toBe("4. Board + columns");
    expect(r.steps.at(-1)!.detail).toMatch(/missing the "columns:write" permission/);

    const noWs = await runSmoke({ client, board: null });
    expect(noWs.steps.at(-1)!.detail).toMatch(/KOLABOREYT_WORKSPACE_ID/);

    fake.down = true;
    const down = await runSmoke({ client, board: null });
    expect(down.steps[0].ok).toBe(false);
    expect(down.steps[0].detail).toMatch(/allow api\.kolaboreyt\.com/);
  });

  it("the checker really catches contract mistakes", () => {
    // wrong argument name
    expect(contractErrors(`mutation($b: ID!) { create_item(board: $b, group_id: "g", item_name: "x") { id } }`, { b: "1" }).length).toBeGreaterThan(0);
    // unknown field selected
    expect(contractErrors(`query { me { id phone } }`, {}).length).toBeGreaterThan(0);
    // two mutation roots in one request
    expect(
      contractErrors(`mutation { a: archive_item(board_id: "b", item_id: "i") { id } b: archive_item(board_id: "b", item_id: "j") { id } }`, {}),
    ).toContain("mutation selects 2 root fields (Kolaboreyt allows exactly 1)");
    // missing required variable value
    expect(contractErrors(`query($i: ID!) { items(ids: [$i]) { id } }`, {}).length).toBeGreaterThan(0);
  });

  it("recognises a proxy's bare 403 (no GraphQL errors) as a network block", async () => {
    const client = new KolaboreytClient({
      apiKey: "k",
      baseUrl: "https://x.test",
      minIntervalMs: 0,
      fetchImpl: (async () => new Response("", { status: 403 })) as typeof fetch,
    });
    const r = await runSmoke({ client, board: null });
    expect(r.steps[0].detail).toMatch(/refused before reaching Kolaboreyt \(HTTP 403\).*blocking api\.kolaboreyt\.com/);
  });

  it("maps the proxy's CONNECT refusal to network advice", () => {
    expect(explain(new Error("CONNECT tunnel failed, response 403"))).toMatch(/allow api\.kolaboreyt\.com/);
  });
});
