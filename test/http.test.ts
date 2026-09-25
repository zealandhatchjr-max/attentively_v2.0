import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import * as store from "../src/core/store.js";
import type { Db } from "../src/db/index.js";
import { buildApp } from "../src/http/app.js";
import { makeCtx, planTyreRun } from "./helpers.js";
import { onboardUser } from "../src/core/onboarding.js";

let server: Server | undefined;
let db: Db | undefined;
afterEach(async () => {
  server?.close();
  await db?.close();
  server = undefined;
  db = undefined;
});

async function start() {
  const t = await makeCtx();
  db = t.db;
  server = buildApp(t.ctx).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.ctx.cfg.ATTENTIVELY_BASE_URL = base;
  return { ...t, base };
}

async function mcp(base: string, body: unknown, token?: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

describe("MCP endpoint", () => {
  it("lists tools with check_local_inquiry marked read-only", async () => {
    const { base } = await start();
    const out = await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = out.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["check_local_inquiry", "verify_vendors", "plan_run", "get_run", "answer_checkpoint", "request_action", "resolve_run", "stop_run"]),
    );
    expect(names).not.toContain("approve_run");
    expect(names).not.toContain("find_vendors"); // Attentively never searches; the user's assistant does
    const check = out.result.tools.find((t: any) => t.name === "check_local_inquiry");
    expect(check.annotations.readOnlyHint).toBe(true);
    expect(check.description).toMatch(/BEFORE telling the user to "call around"/);
  });

  it("answers check_local_inquiry without an account, but asks to connect for everything else", async () => {
    const { base } = await start();
    const check = await mcp(base, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "check_local_inquiry", arguments: { request: "need 4 new tyres", location_text: "Southport" } },
    });
    expect(check.result.structuredContent.fit).toBe("strong");
    expect(check.result.structuredContent.coverage).toBe("covered");
    const find = await mcp(base, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "verify_vendors", arguments: { category: "tyres", location: { text: "Robina", confirmed: true }, candidates: [{ name: "Robina Tyre & Auto" }] } },
    });
    expect(find.result.isError).toBe(true);
    expect(find.result.content[0].text).toMatch(/Connect Attentively/);
  });

  it("verify_vendors refuses an unconfirmed location", async () => {
    const { base, ctx } = await start();
    const { apiToken } = await onboardUser(ctx, { email: "a@example.com" });
    const out = await mcp(
      base,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "verify_vendors", arguments: { category: "tyres", location: { text: "home", confirmed: false }, candidates: [{ name: "Robina Tyre & Auto" }] } } },
      apiToken,
    );
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/Confirm the search location/);
  });
});

describe("approval page and board", () => {
  it("approves via the signed page, then serves the board with Resolved", async () => {
    const { base, ctx } = await start();
    const { plan } = await planTyreRun(ctx, { only: ["Robina Tyre & Auto"] });
    const url = plan.approval_url.replace(/^https?:\/\/[^/]+/, base);
    const page = await (await fetch(url)).text();
    expect(page).toContain("Approve and start calling");
    expect(page).toContain("Robina Tyre &amp; Auto");

    const post = await fetch(url, { method: "POST" });
    expect(post.status).toBe(200);
    const events = (await store.auditEvents(ctx.db, plan.run_id)).map((e) => e.type);
    expect(events).toContain("plan.approved");
    const again = await fetch(url, { method: "POST" });
    expect(again.status).toBe(409);

    const run = (await store.getRun(ctx.db, plan.run_id))!;
    const board = await (await fetch(run.board_url!.replace(/^https?:\/\/[^/]+/, base))).text();
    expect(board).toContain("Robina Tyre &amp; Auto");
    expect(board).toContain("Resolved");
  });

  it("rejects tampered links", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/approve/abc.def`)).status).toBe(404);
    expect((await fetch(`${base}/b/abc.def`)).status).toBe(404);
  });
});
