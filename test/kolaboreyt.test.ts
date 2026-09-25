import { afterEach, describe, expect, it } from "vitest";
import * as store from "../src/core/store.js";
import { RunStatus } from "../src/core/types.js";
import type { Db } from "../src/db/index.js";
import { syncBoard } from "../src/orchestrator/board.js";
import { advanceRun, approvePlan, pollBoardResolved } from "../src/orchestrator/runner.js";
import { KolaboreytBoard } from "../src/providers/kolaboreyt.js";
import { FakeKolaboreyt } from "./fakes/kolaboreyt.js";
import { makeCtx, planTyreRun } from "./helpers.js";

let db: Db | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function setup() {
  const t = await makeCtx();
  db = t.db;
  const fake = new FakeKolaboreyt();
  const board = new KolaboreytBoard({
    apiKey: "kby_test_key",
    baseUrl: "https://api.kolaboreyt.test",
    workspaceId: "ws_1",
    boardName: "Attentively: Quotes",
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: fake.fetch as typeof fetch,
    db: t.db,
  });
  t.ctx.providers.board = board;
  return { ...t, fake, board };
}

async function runToEnd(t: Awaited<ReturnType<typeof setup>>, only: string[]) {
  const { plan, user } = await planTyreRun(t.ctx, { only });
  await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
  for (let i = 0; i < 40; i++) {
    t.clock.now = new Date(t.clock.now.getTime() + 20_000);
    await advanceRun(t.ctx, plan.run_id);
    if ((await store.getRun(t.db, plan.run_id))!.status !== RunStatus.Running) break;
  }
  return { plan, user };
}

describe("Kolaboreyt board adapter", () => {
  it("follows the API contract: auth + version headers, one mutation per request, idempotency keys", async () => {
    const t = await setup();
    await runToEnd(t, ["Robina Tyre & Auto"]);
    expect(t.fake.requests.length).toBeGreaterThan(0);
    for (const r of t.fake.requests) {
      expect(r.headers.authorization).toBe("Bearer kby_test_key");
      expect(r.headers["api-version"]).toBe("2026-07");
    }
    const roots = /\b(create_board|create_column|create_item|create_subitem|change_column_value|add_item_update)\(/g;
    for (const m of t.fake.mutations()) {
      expect(m.headers["idempotency-key"]).toMatch(/^attentively:/);
      expect(m.query.match(roots)).toHaveLength(1);
    }
  });

  it("documents a run: one item, a subitem per vendor, offers in columns, transcripts as comments", async () => {
    const t = await setup();
    const { plan } = await runToEnd(t, ["Robina Tyre & Auto", "Varsity Tyrepower"]);
    const run = (await store.getRun(t.db, plan.run_id))!;
    const runItem = run.board_id!;
    expect(t.fake.boards.map((b) => b.name)).toEqual(["Attentively: Quotes"]);
    expect([...t.fake.items.values()].filter((i) => i.parent === null)).toHaveLength(1);
    const subs = [...t.fake.items].filter(([, i]) => i.parent === runItem);
    expect(subs.map(([, i]) => i.name).sort()).toEqual(["Robina Tyre & Auto", "Varsity Tyrepower"]);

    expect(t.fake.cellsOf(runItem, "Status")).toEqual({ label: "Complete" });
    expect(t.fake.cellsOf(runItem, "Best price")).toBe(620);
    expect(t.fake.cellsOf(runItem, "Best vendor")).toBe("Varsity Tyrepower");
    expect(t.fake.cellsOf(runItem, "Report").href).toMatch(/\/b\//);

    const robina = subs.find(([, i]) => i.name === "Robina Tyre & Auto")![0];
    expect(t.fake.cellsOf(robina, "Call status", "subitem")).toEqual({ label: "Done" });
    expect(t.fake.cellsOf(robina, "Phone", "subitem")).toEqual({ number: "+61755550101" });
    expect(t.fake.cellsOf(robina, "Price", "subitem")).toBe(660);
    expect(t.fake.cellsOf(robina, "Contact", "subitem")).toBe("Dave");

    const calls = (await store.runCalls(t.db, plan.run_id)).filter((c) => c.processed_at);
    expect(t.fake.updates).toHaveLength(calls.length);
    expect(t.fake.updates.find((u) => u.item === robina)!.body).toMatch(/Maddie: Hi, I'm Maddie/);
  });

  it("is idempotent: re-syncing writes nothing new, and a restart reuses the board and columns", async () => {
    const t = await setup();
    const { plan } = await runToEnd(t, ["Robina Tyre & Auto"]);
    const before = t.fake.mutations().length;
    await syncBoard(t.ctx, plan.run_id);
    expect(t.fake.mutations().length).toBe(before);

    const restarted = new KolaboreytBoard({
      apiKey: "kby_test_key",
      baseUrl: "https://api.kolaboreyt.test",
      workspaceId: "ws_1",
      boardName: "Attentively: Quotes",
      minIntervalMs: 0,
      fetchImpl: t.fake.fetch as typeof fetch,
      db: t.db,
    });
    await restarted.ensureSchema();
    expect(t.fake.boards).toHaveLength(1);
    expect(t.fake.mutations().length).toBe(before);
  });

  it("retries a 429 with the same idempotency key", async () => {
    const t = await setup();
    await t.board.ensureSchema();
    t.fake.failNext = 429;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    const reqs = t.fake.requests;
    const i = reqs.findIndex((r, idx) => idx > 0 && r.headers["idempotency-key"] && r.headers["idempotency-key"] === reqs[idx - 1].headers["idempotency-key"]);
    expect(i).toBeGreaterThan(0); // the retried request reused its key
    expect((await store.getRun(t.db, plan.run_id))!.board_id).toBeTruthy();
  });

  it("marking Resolved in Kolaboreyt resolves the run and stops emails", async () => {
    const t = await setup();
    const { plan, user } = await runToEnd(t, ["Robina Tyre & Auto"]);
    const run = (await store.getRun(t.db, plan.run_id))!;
    const statusCol = t.fake.columns.find((c) => c.title === "Status" && c.owner_kind === "item")!;
    t.fake.cells.set(`${run.board_id}:${statusCol.id}`, JSON.stringify({ label: "Resolved" }));

    expect(await pollBoardResolved(t.ctx)).toBe(1);
    expect((await store.getRun(t.db, plan.run_id))!.resolved_at).not.toBeNull();
    const emails = t.mailer.sent.length;
    const { inboundMessage } = await import("../src/inbound/index.js");
    await inboundMessage(t.ctx, { channel: "sms", to: user.assistant_number!, from: "+61755550101", body: "Can do $600" });
    expect(t.mailer.sent.length).toBe(emails);
  });

  it("never lets a Kolaboreyt outage block calls", async () => {
    const t = await setup();
    t.fake.down = true;
    const { plan } = await runToEnd(t, ["Robina Tyre & Auto"]);
    const run = (await store.getRun(t.db, plan.run_id))!;
    expect(run.status).toBe(RunStatus.Completed);
    expect((await store.runCalls(t.db, plan.run_id)).length).toBe(1);
  });
});

describe("board sync stability", () => {
  it("doesn't rewrite the Report link on every sync (signed links embed an expiry)", async () => {
    const t = await setup();
    const { plan } = await runToEnd(t, ["Robina Tyre & Auto"]);
    const before = t.fake.mutations().length;
    await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary
    await syncBoard(t.ctx, plan.run_id);
    expect(t.fake.mutations().length).toBe(before);
  });
});
