/**
 * End-to-end simulation of a Gold Coast tyre run with fake vendors.
 * No keys needed: embedded Postgres, simulated calls, emails printed to the console.
 *
 *   npm run simulate
 */
import { loadConfig } from "../config.js";
import type { Ctx } from "../core/context.js";
import { onboardUser } from "../core/onboarding.js";
import * as store from "../core/store.js";
import { RunStatus } from "../core/types.js";
import { openDb } from "../db/index.js";
import { inboundMessage } from "../inbound/index.js";
import { checkLocalInquiry, planRun, verifyVendors, requestAction, runView } from "../orchestrator/planning.js";
import { advanceRun, answerCheckpoint, approvePlan, resolveRun } from "../orchestrator/runner.js";
import { ASSISTANT_SEARCH_RESULTS } from "../providers/fake/vendors.js";
import { FakeExtractor, FakeNumbers, FakePlaces, FakeVoice, LocalBoard, MemoryMailer } from "../providers/fake/index.js";

const say = (s: string) => console.log(`\n\x1b[1m▶ ${s}\x1b[0m`);

export async function simulate(opts: { quiet?: boolean } = {}) {
  const cfg = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  const db = await openDb({});
  const mailer = new MemoryMailer(!opts.quiet);
  // Wednesday 10:00 in Brisbane: shops are open.
  let clock = new Date("2026-09-23T00:00:00Z");
  const ctx: Ctx = {
    db,
    cfg,
    providers: {
      voice: new FakeVoice(1),
      numbers: new FakeNumbers(),
      places: new FakePlaces(),
      extractor: new FakeExtractor(),
      mailer,
      board: new LocalBoard(),
    },
    now: () => clock,
    log: opts.quiet ? () => {} : (m, d) => console.log(`   · ${m}`, d ?? ""),
  };
  const log = opts.quiet ? (_: string) => {} : say;

  const { user } = await onboardUser(ctx, { email: "founder@example.com", share_data_opt_in: true, minutes: 120, owner_name: "Zealand", assistant_name: "Maddie" });
  log(`User onboarded with a hidden assistant number and ${Math.floor(user.minutes_balance_seconds / 60)} minutes`);

  log("ChatGPT notices a local-buy situation and calls check_local_inquiry (no auth, no cost)");
  const check = await checkLocalInquiry(ctx, { request: "front tyre has a bulge, need 4 new ones this week", location_text: "Robina" });
  if (!opts.quiet) console.log(`   fit=${check.fit} category=${check.category} coverage=${check.coverage}`);

  const location = { text: "Robina, Gold Coast QLD", confirmed: true };
  log("ChatGPT searches the web itself (user's subscription) and finds 8 shops. User: \"yes, ring around\"");
  log("verify_vendors: Attentively checks each shop with Google (only now, after the user agreed)");
  const found = await verifyVendors(ctx, user.id, { category: "tyres", location, candidates: ASSISTANT_SEARCH_RESULTS });
  if (!opts.quiet) {
    for (const v of found.callable) console.log(`   ✓ ${v.name} ${v.phone}${v.phone_corrected ? " (number corrected)" : ""}`);
    for (const v of found.not_callable) console.log(`   ✗ ${v.input_name}: ${v.status}. ${v.note ?? ""}`);
  }

  log('User: "Call all 6." plan_run creates the plan and approval link');
  const recommended = new Set(["Robina Tyre & Auto", "Varsity Tyrepower"]);
  const plan = await planRun(ctx, user.id, {
    request_text: "4 x 205/55R16 91V fitted this week, best overall price",
    category: "tyres",
    location,
    need: { item: "tyres", quantity: 4, required_by: "2026-09-26", specs: { size: "205/55R16", load_speed_index: "91V", fitted: true } },
    vendors: found.callable.map((v) => ({ vendor_id: v.vendor_id!, selected: true, recommended: recommended.has(v.name!), reason: recommended.has(v.name!) ? "Lists 205/55R16 and open Saturday" : undefined })),
  });
  if (!opts.quiet) console.log(`   approval_url: ${plan.approval_url}\n   estimated ${plan.estimated_minutes} min`);

  log("Before approval: the runner refuses to dial");
  await advanceRun(ctx, plan.run_id);
  if ((await store.runCalls(db, plan.run_id)).length !== 0) throw new Error("dialled before approval!");

  log("User presses Approve on the plan page");
  await approvePlan(ctx, { runId: plan.run_id, userId: user.id, planVersion: plan.plan_version, method: "approval_page" });

  for (let i = 0; i < 60; i++) {
    clock = new Date(clock.getTime() + 20_000);
    await advanceRun(ctx, plan.run_id);
    const run = (await store.getRun(db, plan.run_id))!;
    if (run.status === RunStatus.NeedsUser) {
      const [q] = (await runView(ctx, plan.run_id)).needs_you;
      log(`Needs you: ${q.vendor} asked "${q.question}". User answers in ChatGPT: "No, they're not run-flats."`);
      await answerCheckpoint(ctx, { runId: plan.run_id, userId: user.id, checkpointId: q.checkpoint_id, answer: "No, they're not run-flats.", via: "chat" });
    }
    if (run.status === RunStatus.Completed) break;
  }

  const firstCall = (await store.runCalls(db, plan.run_id)).find((c) => Array.isArray(c.transcript) && (c.transcript as unknown[]).length);
  if (!opts.quiet && firstCall) {
    log("How the first call opened:");
    for (const t of (firstCall.transcript as Array<{ role: string; text: string }>).slice(0, 3)) console.log(`   ${t.role === "agent" ? "Maddie" : "Vendor"}: ${t.text}`);
  }
  const view = await runView(ctx, plan.run_id);
  log("Run complete. Vendor board:");
  if (!opts.quiet) for (const v of view.vendors) console.log(`   - ${v.name}: ${v.status}${v.offers.length ? ` | ${v.offers.map((o) => `${o.kind}/${o.phase} $${o.total_price}`).join(", ")}` : ""}`);

  log("User asks for round two; a new approval is required");
  const r2 = await requestAction(ctx, user.id, { run_id: plan.run_id, action: "round_two" }).catch((e) => ({ error: String(e) }));
  if (!opts.quiet) console.log("   ", "approval_url" in r2 ? `round 2 plan v${r2.plan_version}: ${r2.vendors_to_call.map((v) => v.name).join(", ")}` : r2);

  log("Late info: Robina texts the assistant number with a better price");
  await inboundMessage(ctx, { channel: "sms", to: user.assistant_number!, from: "+61755550101", body: "Hi it's Dave, can do $600 fitted for the Michelins if they book this week." });

  log("User presses Resolved; later messages are logged quietly, no more emails");
  await resolveRun(ctx, plan.run_id, user.id, "board");
  const before = mailer.sent.length;
  await inboundMessage(ctx, { channel: "sms", to: user.assistant_number!, from: "+61755550102", body: "Mel here, can do $590." });

  const audit = await store.auditEvents(db, plan.run_id);
  const summary = {
    run_id: plan.run_id,
    status: (await store.getRun(db, plan.run_id))!.status,
    calls: (await store.runCalls(db, plan.run_id)).length,
    emails: mailer.sent.map((m) => m.subject),
    emails_after_resolve: mailer.sent.length - before,
    calls_before_approval: audit.findIndex((a) => a.type === "call.dialed") < audit.findIndex((a) => a.type === "plan.approved") ? 1 : 0,
    dnc_recorded: (await store.vendorByPhone(db, "+61755550104"))!.dnc,
    verified: found.callable.map((v) => v.name),
    dropped: found.not_callable.map((v) => `${v.input_name}: ${v.status}`),
    phone_corrected: found.callable.filter((v) => v.phone_corrected).map((v) => v.name),
    minutes_left: Math.floor((await store.getUser(db, user.id))!.minutes_balance_seconds / 60),
    view,
    mailer,
  };
  if (!opts.quiet) {
    log("Summary");
    console.log(JSON.stringify({ ...summary, view: undefined, mailer: undefined }, null, 2));
  }
  await db.close();
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  simulate().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
