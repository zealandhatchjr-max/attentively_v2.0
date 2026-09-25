import { afterEach, describe, expect, it } from "vitest";
import * as store from "../src/core/store.js";
import { RunStatus, VendorItemStatus } from "../src/core/types.js";
import type { Db } from "../src/db/index.js";
import { inboundCallStarted, inboundMessage } from "../src/inbound/index.js";
import { requestAction, runView, verifyVendors } from "../src/orchestrator/planning.js";
import { onboardUser } from "../src/core/onboarding.js";
import { advanceRun, answerCheckpoint, approvePlan, resolveRun } from "../src/orchestrator/runner.js";
import { simulate } from "../src/sim/simulate.js";
import { makeCtx, planTyreRun } from "./helpers.js";

let db: Db | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function drive(ctx: Awaited<ReturnType<typeof makeCtx>>["ctx"], runId: string, clock: { now: Date }, steps = 40) {
  for (let i = 0; i < steps; i++) {
    clock.now = new Date(clock.now.getTime() + 20_000);
    await advanceRun(ctx, runId);
    const s = (await store.getRun(ctx.db, runId))!.status;
    if (s !== RunStatus.Running) return s;
  }
  return (await store.getRun(ctx.db, runId))!.status;
}

describe("full simulated run", () => {
  it("completes the Gold Coast tyre scenario end to end", async () => {
    const s = await simulate({ quiet: true });
    expect(s.status).toBe("resolved");
    expect(s.calls_before_approval).toBe(0);
    expect(s.calls).toBe(7); // 6 vendors + 1 call-back after the Needs-you answer
    expect(s.dnc_recorded).toBe(true);
    expect(s.emails[0]).toMatch(/needs you/i);
    expect(s.emails.some((e) => e.startsWith("Attentively report"))).toBe(true);
    expect(s.emails.some((e) => e.startsWith("Updated report"))).toBe(true);
    expect(s.emails_after_resolve).toBe(0);
    expect(s.minutes_left).toBeLessThan(120);
  });
});

describe("approval gate", () => {
  it("never dials without an approval of the vendor's plan version", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan } = await planTyreRun(t.ctx);
    // Force the run to Running without approving it.
    await store.setRunStatus(t.db, plan.run_id, RunStatus.Running, { next_action_at: t.clock.now });
    await advanceRun(t.ctx, plan.run_id);
    expect(await store.runCalls(t.db, plan.run_id)).toHaveLength(0);
    const events = (await store.auditEvents(t.db, plan.run_id)).map((e) => e.type);
    expect(events).toContain("call.blocked_no_approval");
    expect((await store.getRun(t.db, plan.run_id))!.status).toBe(RunStatus.AwaitingApproval);
  });

  it("rejects a stale approval link after the plan changes", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await store.addPlanVersion(t.db, plan.run_id, { ...(await store.getPlan(t.db, plan.run_id))!, round: 1 });
    const r = await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/changed/);
  });

  it("won't let another user approve", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan } = await planTyreRun(t.ctx);
    const r = await approvePlan(t.ctx, { runId: plan.run_id, userId: "usr_someone_else", planVersion: 1, method: "approval_page" });
    expect(r.ok).toBe(false);
  });
});

describe("dialing", () => {
  it("reserves each (run, vendor, round, attempt) exactly once", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx);
    const vendorId = (await store.runVendors(t.db, plan.run_id))[0].vendor_id;
    const args = { run_id: plan.run_id, vendor_id: vendorId, user_id: user.id, round: 1, attempt_no: 1, plan_version: 1, brief_version: 1, provider: "fake", leverage: null };
    expect(await store.reserveOutboundCall(t.db, args)).not.toBeNull();
    expect(await store.reserveOutboundCall(t.db, args)).toBeNull();
  });

  it("queues calls until shops open", async () => {
    const t = await makeCtx();
    db = t.db;
    t.clock.now = new Date("2026-09-27T09:00:00Z"); // Sunday 19:00 Brisbane
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Burleigh Wheel Centre"] }); // weekdays only
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await advanceRun(t.ctx, plan.run_id);
    expect(await store.runCalls(t.db, plan.run_id)).toHaveLength(0);
    const run = (await store.getRun(t.db, plan.run_id))!;
    expect(new Date(run.next_action_at!).toISOString()).toBe("2026-09-27T22:00:00.000Z"); // Mon 08:00
  });

  it("uses the best real quote as leverage only on later calls", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Varsity Tyrepower", "Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    const calls = await store.runCalls(t.db, plan.run_id);
    expect(calls[0].leverage).toBeNull();
    expect(calls[1].leverage).toMatchObject({ total: expect.any(Number) });
    for (const c of calls) expect((c.negotiation_check as { ok: boolean }).ok).toBe(true);
  });

  it("skips vendors who asked not to be called, in every later run", async () => {
    const t = await makeCtx();
    db = t.db;
    const first = await planTyreRun(t.ctx, { only: ["Nerang Discount Tyres"] });
    await approvePlan(t.ctx, { runId: first.plan.run_id, userId: first.user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, first.plan.run_id, t.clock);
    const second = await planTyreRun(t.ctx, { only: ["Nerang Discount Tyres", "Robina Tyre & Auto"] });
    expect(second.plan.vendors_to_call.map((v) => v.name)).toEqual(["Robina Tyre & Auto"]);
    expect(second.found.not_callable.find((v) => v.input_name === "Nerang Discount Tyres")?.status).toBe("do_not_call");
  });
});

describe("minutes", () => {
  it("pauses before the next call and emails the user when minutes run out", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { minutes: 4, only: ["Robina Tyre & Auto", "Varsity Tyrepower"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    const status = await drive(t.ctx, plan.run_id, t.clock);
    expect(status).toBe(RunStatus.PausedMinutes);
    expect(await store.runCalls(t.db, plan.run_id)).toHaveLength(1);
    expect(t.mailer.sent.at(-1)!.subject).toMatch(/out of minutes/i);
  });
});

describe("needs you", () => {
  it("carries on without the answer after the timeout and lists it in the report", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Burleigh Wheel Centre", "Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    expect(await drive(t.ctx, plan.run_id, t.clock)).toBe(RunStatus.NeedsUser);
    t.clock.now = new Date(t.clock.now.getTime() + 3 * 3600_000);
    await store.scheduleRun(t.db, plan.run_id, t.clock.now);
    await advanceRun(t.ctx, plan.run_id);
    expect(await drive(t.ctx, plan.run_id, t.clock)).toBe(RunStatus.Completed);
    const run = (await store.getRun(t.db, plan.run_id))!;
    expect((run.report as any).unanswered_questions[0].question).toMatch(/run-flat/);
  });

  it("an answer versions the brief and re-queues the vendor who asked", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Burleigh Wheel Centre"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    const [q] = (await runView(t.ctx, plan.run_id)).needs_you;
    const before = (await store.getBrief(t.db, plan.run_id)).version;
    await answerCheckpoint(t.ctx, { runId: plan.run_id, userId: user.id, checkpointId: q.checkpoint_id, answer: "Not run-flats", via: "board" });
    const brief = await store.getBrief(t.db, plan.run_id);
    expect(brief.version).toBe(before + 1);
    expect(brief.brief.resolved_answers[0].answer).toBe("Not run-flats");
    expect(await drive(t.ctx, plan.run_id, t.clock)).toBe(RunStatus.Completed);
    const calls = await store.runCalls(t.db, plan.run_id);
    expect(calls).toHaveLength(2);
    expect(calls[1].brief_version).toBe(brief.version);
    expect(calls[1].attempt_no).toBe(2);
  });
});

describe("inbound assistant", () => {
  it("recognises a vendor calling back and loads the earlier call", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    const c = await inboundCallStarted(t.ctx, { agentNumber: user.assistant_number!, callerNumber: "+61755550101" });
    expect(c.run_id).toBe(plan.run_id);
    expect(c.systemPrompt).toContain("Robina Tyre & Auto");
    expect(c.systemPrompt).toContain("Summary of our last call");
    expect(c.firstMessage).toMatch(/Dave/);

    const stranger = await inboundCallStarted(t.ctx, { agentNumber: user.assistant_number!, callerNumber: "+61400000000" });
    expect(stranger.run_id).toBeNull();
    expect(stranger.systemPrompt).toMatch(/Take a message/);
  });

  it("after Resolved, late messages are logged but never emailed", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    await inboundMessage(t.ctx, { channel: "sms", to: user.assistant_number!, from: "+61755550101", body: "Can do $610" });
    expect(t.mailer.sent.at(-1)!.subject).toMatch(/^Updated report/);
    await resolveRun(t.ctx, plan.run_id, user.id, "board");
    const n = t.mailer.sent.length;
    await inboundMessage(t.ctx, { channel: "sms", to: user.assistant_number!, from: "+61755550101", body: "Can do $590" });
    expect(t.mailer.sent.length).toBe(n);
    const c = await inboundCallStarted(t.ctx, { agentNumber: user.assistant_number!, callerNumber: "+61755550101" });
    expect(c.systemPrompt).toMatch(/already sorted/);
  });

  it("forwards unmatched messages to the user", async () => {
    const t = await makeCtx();
    db = t.db;
    const { user } = await planTyreRun(t.ctx);
    await inboundMessage(t.ctx, { channel: "email", to: user.assistant_email!, from: "someone@else.com", subject: "hello", body: "random" });
    expect(t.mailer.sent.at(-1)!.subject).toMatch(/Message for you/);
  });
});

describe("shared vendor memory", () => {
  it("shares only opted-in observations, without who asked", async () => {
    const t = await makeCtx();
    db = t.db;
    const sharer = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"], share: true });
    await approvePlan(t.ctx, { runId: sharer.plan.run_id, userId: sharer.user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, sharer.plan.run_id, t.clock);
    const private_ = await planTyreRun(t.ctx, { only: ["Varsity Tyrepower"], share: false });
    await approvePlan(t.ctx, { runId: private_.plan.run_id, userId: private_.user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, private_.plan.run_id, t.clock);

    const third = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    const robina = third.found.callable.find((v) => v.name === "Robina Tyre & Auto")!;
    const varsity = third.found.callable.find((v) => v.name === "Varsity Tyrepower")!;
    expect(robina.recent_observations.length).toBeGreaterThan(0);
    expect(varsity.recent_observations).toHaveLength(0);
    expect(JSON.stringify(robina.recent_observations)).not.toContain(sharer.user.id);
  });
});

describe("follow-ups", () => {
  it("round two needs a fresh approval before any call", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto", "Varsity Tyrepower"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    const r2 = (await requestAction(t.ctx, user.id, { run_id: plan.run_id, action: "round_two" })) as Extract<Awaited<ReturnType<typeof requestAction>>, { plan_version: number }>;
    expect(r2.vendors_to_call.map((v) => v.name)).toEqual(["Robina Tyre & Auto"]);
    const callsBefore = (await store.runCalls(t.db, plan.run_id)).length;
    await store.setRunStatus(t.db, plan.run_id, RunStatus.Running, { next_action_at: t.clock.now });
    await advanceRun(t.ctx, plan.run_id);
    expect((await store.runCalls(t.db, plan.run_id)).length).toBe(callsBefore); // blocked: v2 not approved
    await store.setRunStatus(t.db, plan.run_id, RunStatus.AwaitingApproval);
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: r2.plan_version, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    const calls = await store.runCalls(t.db, plan.run_id);
    expect(calls.at(-1)!.round).toBe(2);
    const items = await store.runVendors(t.db, plan.run_id);
    expect(items.find((i) => i.vendor.name === "Robina Tyre & Auto")!.status).toBe(VendorItemStatus.Done);
  });

  it("exports CSV", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await drive(t.ctx, plan.run_id, t.clock);
    const out = (await requestAction(t.ctx, user.id, { run_id: plan.run_id, action: "export_csv" })) as { csv: string };
    expect(out.csv.split("\n")[0]).toContain("vendor");
    expect(out.csv).toContain("Robina Tyre & Auto");
  });
});

describe("worker", () => {
  it("leases due runs once, so two workers never advance the same run", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await t.db.query(`UPDATE runs SET next_action_at = now() - interval '1 second' WHERE id=$1`, [plan.run_id]);
    const first = await store.leaseDueRuns(t.db, [RunStatus.Running, RunStatus.NeedsUser], 60);
    const second = await store.leaseDueRuns(t.db, [RunStatus.Running, RunStatus.NeedsUser], 60);
    expect(first).toEqual([plan.run_id]);
    expect(second).toEqual([]);
  });
});

describe("vendor verification (Google Places, only after the user opts in)", () => {
  const location = { text: "Robina, Gold Coast QLD", confirmed: true };

  it("check_local_inquiry never touches Google", async () => {
    const t = await makeCtx();
    db = t.db;
    const { checkLocalInquiry } = await import("../src/orchestrator/planning.js");
    await checkLocalInquiry(t.ctx, { request: "need 4 tyres", location_text: "Robina" });
    expect((t.ctx.providers.places as any).lookups).toBe(0);
  });

  it("drops permanently and temporarily closed businesses and unknown ones", async () => {
    const t = await makeCtx();
    db = t.db;
    const { user } = await onboardUser(t.ctx, { email: "v@example.com" });
    const r = await verifyVendors(t.ctx, user.id, {
      category: "tyres",
      location,
      candidates: [
        { name: "Tugun Tyre Centre", phone: "07 5555 0107" },
        { name: "Ashmore Tyre World" },
        { name: "Coomera Tyre Barn", phone: "07 5555 0199" },
        { name: "Robina Tyre & Auto" },
      ],
    });
    expect(r.callable.map((v) => v.name)).toEqual(["Robina Tyre & Auto"]);
    expect(Object.fromEntries(r.not_callable.map((v) => [v.input_name, v.status]))).toEqual({
      "Tugun Tyre Centre": "closed_permanently",
      "Ashmore Tyre World": "closed_temporarily",
      "Coomera Tyre Barn": "not_found",
    });
  });

  it("corrects an out-of-date phone number from the assistant's search", async () => {
    const t = await makeCtx();
    db = t.db;
    const { user } = await onboardUser(t.ctx, { email: "v@example.com" });
    const r = await verifyVendors(t.ctx, user.id, { category: "tyres", location, candidates: [{ name: "Burleigh Wheel Centre", phone: "07 5555 0199" }] });
    expect(r.callable[0].phone).toBe("+61755550103");
    expect(r.callable[0].phone_corrected).toBe(true);
  });

  it("reuses recent verifications instead of paying for another lookup", async () => {
    const t = await makeCtx();
    db = t.db;
    const { user } = await onboardUser(t.ctx, { email: "v@example.com" });
    const cands = [{ name: "Robina Tyre & Auto", phone: "07 5555 0101" }];
    await verifyVendors(t.ctx, user.id, { category: "tyres", location, candidates: cands });
    const after1 = (t.ctx.providers.places as any).lookups;
    await verifyVendors(t.ctx, user.id, { category: "tyres", location, candidates: cands });
    expect((t.ctx.providers.places as any).lookups).toBe(after1);
    t.clock.now = new Date(t.clock.now.getTime() + 15 * 86400_000); // older than VERIFY_MAX_AGE_DAYS
    await verifyVendors(t.ctx, user.id, { category: "tyres", location, candidates: cands });
    expect((t.ctx.providers.places as any).lookups).toBe(after1 + 1);
  });

  it("caps Google lookups per user per day", async () => {
    const t = await makeCtx({ PLACES_LOOKUPS_PER_USER_PER_DAY: "2" });
    db = t.db;
    const { user } = await onboardUser(t.ctx, { email: "v@example.com" });
    const r = await verifyVendors(t.ctx, user.id, {
      category: "tyres",
      location,
      candidates: [{ name: "Robina Tyre & Auto" }, { name: "Varsity Tyrepower" }, { name: "Mudgeeraba Tyres" }],
    });
    expect(r.callable).toHaveLength(2);
    expect(r.not_callable[0].status).toBe("lookup_limit");
  });

  it("never calls a business that closed after the plan was approved", async () => {
    const t = await makeCtx();
    db = t.db;
    const { plan, user } = await planTyreRun(t.ctx, { only: ["Robina Tyre & Auto"] });
    await approvePlan(t.ctx, { runId: plan.run_id, userId: user.id, planVersion: 1, method: "approval_page" });
    await t.db.query(`UPDATE vendors SET business_status='CLOSED_PERMANENTLY' WHERE phone_e164='+61755550101'`);
    await drive(t.ctx, plan.run_id, t.clock);
    expect(await store.runCalls(t.db, plan.run_id)).toHaveLength(0);
    expect((await store.auditEvents(t.db, plan.run_id)).map((e) => e.type)).toContain("call.skipped_closed");
  });
});
