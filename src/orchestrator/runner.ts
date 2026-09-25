import { getCategory, questionsFor } from "../categories/index.js";
import { boardUrl, type Ctx } from "../core/context.js";
import { isOpen, nextOpening } from "../core/hours.js";
import * as store from "../core/store.js";
import { RunStatus, VendorItemStatus, type Extraction, type TranscriptTurn } from "../core/types.js";
import type { ProviderCallState } from "../providers/types.js";
import { ensureBoard, syncBoard } from "./board.js";
import { sendReport } from "./report.js";
import { personaOf } from "../core/persona.js";
import { buildCallPrompt, checkNegotiation, type Leverage } from "./script.js";

const LEASE_SECONDS = 120;
const DIAL_STUCK_MS = 2 * 60_000;
const TERMINAL: ProviderCallState["status"][] = ["completed", "no_answer", "busy", "failed"];

/**
 * Advances one run as far as it can go without waiting, then schedules the next
 * wake-up in runs.next_action_at. Safe to call repeatedly and concurrently: a
 * lease ensures one advancer per run, and every step is idempotent.
 */
export async function advanceRun(ctx: Ctx, runId: string, opts: { alreadyLeased?: boolean } = {}): Promise<void> {
  if (!opts.alreadyLeased && !(await store.leaseRun(ctx.db, runId, LEASE_SECONDS))) return;
  try {
    for (let i = 0; i < 25; i++) {
      const done = await step(ctx, runId);
      if (done) return;
    }
  } finally {
    await store.releaseRun(ctx.db, runId);
  }
}

/** One unit of progress. Returns true when the run must wait (or is finished). */
async function step(ctx: Ctx, runId: string): Promise<boolean> {
  const { db, cfg } = ctx;
  const run = await store.getRun(db, runId);
  if (!run || (run.status !== RunStatus.Running && run.status !== RunStatus.NeedsUser)) return true;
  const now = ctx.now();

  // 1. A call in flight: poll it, or process it once it's finished.
  const call = await store.activeOutboundCall(db, runId);
  if (call) {
    if (!call.provider_call_id) {
      if (now.getTime() - new Date(call.started_at).getTime() > DIAL_STUCK_MS) {
        // We don't know if the dial went out. Never redial automatically: mark failed.
        await store.updateCall(db, call.id, { status: "failed", failure_reason: "dial_state_unknown", processed_at: now });
        await store.setVendorItemStatus(db, runId, call.vendor_id!, VendorItemStatus.Failed);
        await store.audit(db, { run_id: runId, actor: "system", type: "call.dial_unknown", data: { call_id: call.id } });
        return false;
      }
      await store.scheduleRun(db, runId, new Date(now.getTime() + cfg.CALL_POLL_SECONDS * 1000));
      return true;
    }
    const state = await ctx.providers.voice.getCall(call.provider_call_id);
    if (!TERMINAL.includes(state.status)) {
      await store.scheduleRun(db, runId, new Date(now.getTime() + cfg.CALL_POLL_SECONDS * 1000));
      return true;
    }
    await processOutboundCall(ctx, runId, call.id, state);
    return false;
  }

  // 2. Needs-you questions: wait until answered or timed out, then carry on.
  const open = await store.openCheckpoints(db, runId);
  let stillOpen = 0;
  for (const c of open) {
    if (new Date(c.deadline_at) <= now) {
      await store.resolveCheckpoint(db, c.id, "skipped");
      if (c.vendor_id) await store.setVendorItemStatus(db, runId, c.vendor_id, VendorItemStatus.Skipped);
      await store.audit(db, { run_id: runId, actor: "system", type: "checkpoint.timed_out", data: { checkpoint_id: c.id } });
    } else stillOpen += 1;
  }
  if (stillOpen) {
    const earliest = open.map((c) => new Date(c.deadline_at)).sort((a, b) => a.getTime() - b.getTime())[0];
    if (run.status !== RunStatus.NeedsUser) {
      await store.setRunStatus(db, runId, RunStatus.NeedsUser, { next_action_at: earliest });
      await syncBoard(ctx, runId);
    } else await store.scheduleRun(db, runId, earliest);
    return true;
  }
  if (run.status === RunStatus.NeedsUser) {
    await store.setRunStatus(db, runId, RunStatus.Running, { next_action_at: now });
    return false;
  }

  // 3. Next vendor.
  const items = await store.runVendors(db, runId);
  const queued = items.filter((i) => i.selected && i.status === VendorItemStatus.Queued);
  if (!queued.length) {
    await finishRun(ctx, runId);
    return true;
  }

  if ((await store.outboundCallCount(db, runId)) >= cfg.MAX_CALLS_PER_RUN) {
    for (const q of queued) await store.setVendorItemStatus(db, runId, q.vendor_id, VendorItemStatus.Skipped);
    await store.audit(db, { run_id: runId, actor: "system", type: "run.safety_ceiling_reached", data: { max: cfg.MAX_CALLS_PER_RUN } });
    await finishRun(ctx, runId);
    return true;
  }

  const user = (await store.getUser(db, run.user_id))!;
  if (user.minutes_balance_seconds < cfg.MIN_SECONDS_TO_DIAL) {
    await store.setRunStatus(db, runId, RunStatus.PausedMinutes, { pause_reason: "out_of_minutes" });
    await ctx.providers.mailer.send({
      to: run.request.notify_email,
      subject: "Attentively paused: out of minutes",
      text:
        `Your assistant has run out of call minutes partway through "${run.request.need.item}".\n\n` +
        `Top up to carry on calling the remaining ${queued.length} vendor(s), or get the report with what we have so far.\n\n` +
        `Board: ${boardUrl(ctx, runId, run.user_id)}`,
    });
    await store.audit(db, { run_id: runId, actor: "system", type: "run.paused_out_of_minutes" });
    await syncBoard(ctx, runId);
    return true;
  }

  const tz = (v: { timezone: string | null }) => v.timezone ?? run.location.timezone ?? cfg.DEFAULT_TIMEZONE;
  let target: (typeof queued)[number] | undefined;
  let wakeAt: Date | null = null;
  for (const q of queued) {
    if (q.vendor.dnc) {
      await store.setVendorItemStatus(db, runId, q.vendor_id, VendorItemStatus.Skipped);
      await store.audit(db, { run_id: runId, actor: "system", type: "call.blocked_dnc", data: { vendor_id: q.vendor_id } });
      continue;
    }
    if (q.vendor.business_status && q.vendor.business_status !== "OPERATIONAL") {
      await store.setVendorItemStatus(db, runId, q.vendor_id, VendorItemStatus.Skipped);
      await store.audit(db, { run_id: runId, actor: "system", type: "call.skipped_closed", data: { vendor_id: q.vendor_id, business_status: q.vendor.business_status } });
      continue;
    }
    if (!q.vendor.hours?.length) {
      await store.setVendorItemStatus(db, runId, q.vendor_id, VendorItemStatus.Skipped);
      await store.audit(db, { run_id: runId, actor: "system", type: "call.skipped_unknown_hours", data: { vendor_id: q.vendor_id } });
      continue;
    }
    if (isOpen(q.vendor.hours, now, tz(q.vendor))) {
      target = q;
      break;
    }
    const next = nextOpening(q.vendor.hours, now, tz(q.vendor));
    if (next && (!wakeAt || next < wakeAt)) wakeAt = next;
  }
  if (!target) {
    if (wakeAt) {
      // Queue until the next shop opens.
      await store.scheduleRun(db, runId, wakeAt);
      return true;
    }
    return false; // everything left was skipped; loop re-evaluates and finishes
  }

  await dial(ctx, runId, target.vendor_id);
  await store.scheduleRun(db, runId, new Date(now.getTime() + cfg.CALL_POLL_SECONDS * 1000));
  return true;
}

/** Lowest real exact quote in this run from another vendor: the only figure the agent may cite. */
async function pickLeverage(ctx: Ctx, runId: string, targetVendorId: string): Promise<Leverage | null> {
  const obs = await store.runObservations(ctx.db, runId);
  const candidates = obs.filter(
    (o) => o.kind === "exact" && o.vendor_id !== targetVendorId && typeof o.data.total_price === "number",
  );
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b.data.total_price! < a.data.total_price! ? b : a));
  const vendor = (await store.getVendor(ctx.db, best.vendor_id))!;
  return { vendor_name: vendor.name, total: best.data.total_price!, observation_evidence: best.evidence ?? "" };
}

async function dial(ctx: Ctx, runId: string, vendorId: string): Promise<void> {
  const { db } = ctx;
  const run = (await store.getRun(db, runId))!;
  const item = (await store.runVendors(db, runId)).find((i) => i.vendor_id === vendorId)!;

  // Invariant: no call without a recorded approval of the plan version that selected this vendor.
  if (!(await store.hasApproval(db, runId, item.plan_version))) {
    await store.audit(db, { run_id: runId, actor: "system", type: "call.blocked_no_approval", data: { vendor_id: vendorId, plan_version: item.plan_version } });
    await store.setRunStatus(db, runId, RunStatus.AwaitingApproval);
    return;
  }

  const { version: briefVersion, brief } = await store.getBrief(db, runId);
  const priorAttempts = await store.attemptsFor(db, runId, vendorId, item.round);
  const leverage = brief.allow_negotiation ? await pickLeverage(ctx, runId, vendorId) : null;
  const callId = await store.reserveOutboundCall(db, {
    run_id: runId,
    vendor_id: vendorId,
    user_id: run.user_id,
    round: item.round,
    attempt_no: priorAttempts + 1,
    plan_version: item.plan_version,
    brief_version: briefVersion,
    provider: ctx.providers.voice.name,
    leverage,
  });
  if (!callId) return; // someone else already dialed this attempt

  await store.setVendorItemStatus(db, runId, vendorId, VendorItemStatus.Calling);
  const user = (await store.getUser(db, run.user_id))!;
  const { systemPrompt, firstMessage } = buildCallPrompt({
    category: run.category,
    vendorName: item.vendor.name,
    brief,
    leverage,
    persona: personaOf(user),
    transcriptionNotice: ctx.cfg.TRANSCRIPTION_NOTICE === "on",
    isCallback: priorAttempts > 0,
  });
  try {
    const { providerCallId } = await ctx.providers.voice.startOutboundCall({
      callId,
      to: item.vendor.phone_e164,
      fromPhoneNumberId: user.voice_phone_number_id,
      systemPrompt,
      firstMessage,
      voiceId: personaOf(user).voiceId,
      metadata: {
        run_id: runId,
        vendor_id: vendorId,
        call_id: callId,
        assistant_email: user.assistant_email ?? "",
        need_qty: String(brief.need.quantity ?? ""),
        need_spec: [brief.need.specs.size, brief.need.specs.load_speed_index].filter(Boolean).join(" ") || brief.need.item,
        leverage_vendor: leverage?.vendor_name ?? "",
        leverage_total: leverage ? String(leverage.total) : "",
        answers: JSON.stringify(brief.resolved_answers.map((a) => `${a.question}: ${a.answer}`)),
      },
    });
    await store.updateCall(db, callId, { provider_call_id: providerCallId, status: "in_progress" });
    await store.audit(db, {
      run_id: runId,
      actor: "system",
      type: "call.dialed",
      data: { call_id: callId, vendor_id: vendorId, brief_version: briefVersion, plan_version: item.plan_version, leverage: leverage ? { vendor: leverage.vendor_name, total: leverage.total } : null },
    });
  } catch (e) {
    await store.updateCall(db, callId, { status: "failed", failure_reason: String(e).slice(0, 500), processed_at: ctx.now() });
    await store.setVendorItemStatus(db, runId, vendorId, VendorItemStatus.Failed);
    await store.audit(db, { run_id: runId, actor: "system", type: "call.dial_failed", data: { call_id: callId, error: String(e).slice(0, 200) } });
  }
  await syncBoard(ctx, runId);
}

export async function processOutboundCall(ctx: Ctx, runId: string, callId: string, state: ProviderCallState): Promise<void> {
  const { db, cfg } = ctx;
  const call = (await store.getCall(db, callId))!;
  if (call.processed_at) return;
  const run = (await store.getRun(db, runId))!;
  const vendor = (await store.getVendor(db, call.vendor_id!))!;
  const user = (await store.getUser(db, run.user_id))!;
  const now = ctx.now();

  // All call time counts, including ringing and no-answers.
  const seconds = Math.max(0, Math.round(state.durationSec ?? 0));
  await store.chargeMinutes(db, run.user_id, seconds, "outbound_call", callId);
  await store.setVendorItemStatus(db, runId, vendor.id, VendorItemStatus.Processing);

  if (state.status !== "completed") {
    const status = state.status === "failed" ? VendorItemStatus.Failed : VendorItemStatus.NoAnswer;
    await store.updateCall(db, callId, {
      status: state.status === "failed" ? "failed" : "no_answer",
      failure_reason: state.failureReason ?? null,
      duration_sec: seconds,
      seconds_charged: seconds,
      ended_at: now,
      transcript: state.transcript ?? null,
      processed_at: now,
    });
    await store.setVendorItemStatus(db, runId, vendor.id, status);
    await store.audit(db, { run_id: runId, actor: "system", type: `call.${status}`, data: { call_id: callId } });
    await syncBoard(ctx, runId);
    return;
  }

  const transcript: TranscriptTurn[] = state.transcript ?? [];
  const { brief } = await store.getBrief(db, runId);
  let extraction: Extraction;
  try {
    extraction = await ctx.providers.extractor.extract({
      category: run.category,
      vendorName: vendor.name,
      need: brief.need,
      questions: questionsFor(getCategory(run.category), brief),
      transcript,
      providerCallId: call.provider_call_id ?? undefined,
    });
  } catch (e) {
    ctx.log("extract.failed", { callId, error: String(e) });
    extraction = {
      outcome: "incomplete",
      do_not_call_requested: false,
      offers: [],
      out_of_brief_questions: [],
      learned_facts: [],
      summary: "Transcript saved; automatic extraction failed and needs review.",
    };
  }

  const others = (await store.runVendors(db, runId)).filter((i) => i.vendor_id !== vendor.id).map((i) => i.vendor.name);
  const negotiation = checkNegotiation(transcript, call.leverage as Leverage | null, others);

  await store.updateCall(db, callId, {
    status: "completed",
    duration_sec: seconds,
    seconds_charged: seconds,
    ended_at: now,
    transcript,
    extraction,
    summary: extraction.summary,
    contact_name: extraction.contact_name ?? null,
    negotiation_check: negotiation,
  });

  if (extraction.offers.length) {
    await store.addObservations(db, {
      run_id: runId,
      call_id: callId,
      vendor_id: vendor.id,
      user_id: run.user_id,
      category: run.category,
      shareable: user.share_data_opt_in,
      offers: extraction.offers,
    });
  }

  if (extraction.learned_facts.length) {
    const cur = await store.getBrief(db, runId);
    await store.addBriefVersion(
      db,
      runId,
      { ...cur.brief, learned_facts: [...cur.brief.learned_facts, ...extraction.learned_facts.map((f) => `${vendor.name}: ${f}`)] },
      `facts from call ${callId}`,
    );
  }

  let itemStatus: VendorItemStatus = VendorItemStatus.Done;
  if (extraction.do_not_call_requested) {
    await store.setDoNotCall(db, vendor.id, "Vendor asked not to be called again", `call:${callId}`);
    await store.audit(db, { run_id: runId, actor: "vendor", type: "vendor.do_not_call", data: { vendor_id: vendor.id } });
    itemStatus = VendorItemStatus.Declined;
  } else if (extraction.outcome === "declined") {
    itemStatus = VendorItemStatus.Declined;
  } else if (extraction.outcome === "no_answer" || extraction.outcome === "voicemail") {
    itemStatus = VendorItemStatus.NoAnswer;
  } else if (extraction.out_of_brief_questions.length) {
    itemStatus = VendorItemStatus.NeedsYou;
    const deadline = new Date(now.getTime() + cfg.NEEDS_YOU_TIMEOUT_MINUTES * 60_000);
    for (const q of extraction.out_of_brief_questions) {
      await store.createCheckpoint(db, { run_id: runId, call_id: callId, vendor_id: vendor.id, question: q.question, why_outside: q.why_outside, deadline_at: deadline });
    }
    await ctx.providers.mailer.send({
      to: run.request.notify_email,
      subject: `Attentively needs you: ${extraction.out_of_brief_questions[0].question}`,
      text:
        `${vendor.name} asked something we can't answer without you:\n\n` +
        extraction.out_of_brief_questions.map((q) => `  • ${q.question}\n    (${q.why_outside})`).join("\n") +
        `\n\nAnswer on the board, or just tell ChatGPT. We'll call ${vendor.name} back with your answer and use it for the remaining calls.\n` +
        `If we don't hear from you in about ${Math.round(cfg.NEEDS_YOU_TIMEOUT_MINUTES / 60)} hours, we'll carry on without it and note it in the report.\n\n` +
        `Board: ${boardUrl(ctx, runId, run.user_id)}`,
    });
  }

  await store.updateCall(db, callId, { processed_at: ctx.now() });
  await store.setVendorItemStatus(db, runId, vendor.id, itemStatus);
  await store.audit(db, { run_id: runId, actor: "system", type: "call.processed", data: { call_id: callId, outcome: extraction.outcome, item_status: itemStatus, negotiation_ok: negotiation.ok } });
  await syncBoard(ctx, runId);
}

async function finishRun(ctx: Ctx, runId: string): Promise<void> {
  const before = (await store.getRun(ctx.db, runId))!;
  await store.setRunStatus(ctx.db, runId, RunStatus.Completed);
  await store.audit(ctx.db, { run_id: runId, actor: "system", type: "run.completed" });
  await sendReport(ctx, runId, { updated: before.report_sent_at !== null });
  await syncBoard(ctx, runId);
}

/** Called when the user approves a plan version (from the approval page or widget). */
export async function approvePlan(
  ctx: Ctx,
  input: { runId: string; userId: string; planVersion: number; method: "approval_page" | "widget" },
): Promise<{ ok: boolean; reason?: string }> {
  const { db } = ctx;
  const run = await store.getRun(db, input.runId);
  if (!run || run.user_id !== input.userId) return { ok: false, reason: "Run not found." };
  if (run.status !== RunStatus.AwaitingApproval) return { ok: false, reason: `This plan isn't awaiting approval (status: ${run.status}).` };
  if (run.current_plan_version !== input.planVersion)
    return { ok: false, reason: "This plan has changed since this link was made. Open the latest plan to approve it." };
  const recorded = await store.recordApproval(db, { run_id: input.runId, plan_version: input.planVersion, user_id: input.userId, method: input.method });
  if (!recorded) return { ok: false, reason: "Already approved." };
  await store.audit(db, { run_id: input.runId, user_id: input.userId, actor: "user", type: "plan.approved", data: { plan_version: input.planVersion, method: input.method } });
  await store.setRunStatus(db, input.runId, RunStatus.Running, { next_action_at: ctx.now() });
  await ensureBoard(ctx, input.runId);
  await syncBoard(ctx, input.runId);
  return { ok: true };
}

/** The user's answer to a Needs-you question: new brief version, callback queued, run resumes. */
export async function answerCheckpoint(
  ctx: Ctx,
  input: { runId: string; userId: string; checkpointId: string; answer: string; via: "chat" | "board" },
): Promise<{ ok: boolean; reason?: string }> {
  const { db } = ctx;
  const run = await store.getRun(db, input.runId);
  if (!run || run.user_id !== input.userId) return { ok: false, reason: "Run not found." };
  const cp = (await store.allCheckpoints(db, input.runId)).find((c) => c.id === input.checkpointId);
  if (!cp) return { ok: false, reason: "Question not found." };
  if (!(await store.resolveCheckpoint(db, cp.id, "answered", input.answer)))
    return { ok: false, reason: "That question was already answered or timed out." };
  const cur = await store.getBrief(db, input.runId);
  await store.addBriefVersion(
    db,
    input.runId,
    { ...cur.brief, resolved_answers: [...cur.brief.resolved_answers, { question: cp.question, answer: input.answer, from_checkpoint: cp.id }] },
    `checkpoint ${cp.id} answered`,
  );
  // The agent promised to call back with the answer: re-queue that vendor.
  if (cp.vendor_id) {
    const vendor = await store.getVendor(db, cp.vendor_id);
    if (vendor && !vendor.dnc) await store.setVendorItemStatus(db, input.runId, cp.vendor_id, VendorItemStatus.Queued);
  }
  await store.audit(db, { run_id: input.runId, user_id: input.userId, actor: "user", type: "checkpoint.answered", data: { checkpoint_id: cp.id, via: input.via } });
  if (run.status === RunStatus.NeedsUser || run.status === RunStatus.Running) {
    await store.scheduleRun(db, input.runId, ctx.now());
  } else if (run.status === RunStatus.Completed && cp.vendor_id) {
    // Late answer after the run finished: the call-back is within the approved plan, so resume.
    await store.setRunStatus(db, input.runId, RunStatus.Running, { next_action_at: ctx.now() });
  }
  return { ok: true };
}

export async function resolveRun(ctx: Ctx, runId: string, userId: string, via: string): Promise<{ ok: boolean; reason?: string }> {
  const run = await store.getRun(ctx.db, runId);
  if (!run || run.user_id !== userId) return { ok: false, reason: "Run not found." };
  if (run.resolved_at) return { ok: true };
  await ctx.db.query(`UPDATE runs SET resolved_at=now(), status=$2, next_action_at=NULL, updated_at=now() WHERE id=$1`, [runId, RunStatus.Resolved]);
  for (const c of await store.openCheckpoints(ctx.db, runId)) await store.resolveCheckpoint(ctx.db, c.id, "skipped");
  await store.audit(ctx.db, { run_id: runId, user_id: userId, actor: "user", type: "run.resolved", data: { via } });
  await syncBoard(ctx, runId);
  return { ok: true };
}

export async function stopRun(ctx: Ctx, runId: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
  const run = await store.getRun(ctx.db, runId);
  if (!run || run.user_id !== userId) return { ok: false, reason: "Run not found." };
  if ([RunStatus.Completed, RunStatus.Resolved, RunStatus.Stopped].includes(run.status as any)) return { ok: true };
  await store.setRunStatus(ctx.db, runId, RunStatus.Stopped);
  const items = await store.runVendors(ctx.db, runId);
  for (const i of items.filter((x) => x.status === VendorItemStatus.Queued))
    await store.setVendorItemStatus(ctx.db, runId, i.vendor_id, VendorItemStatus.Skipped);
  await store.audit(ctx.db, { run_id: runId, user_id: userId, actor: "user", type: "run.stopped" });
  await syncBoard(ctx, runId);
  return { ok: true };
}

/**
 * Someone can mark a run Resolved on the board itself (e.g. the Status column in
 * Kolaboreyt). Boards have no webhooks, so check unresolved runs periodically.
 */
export async function pollBoardResolved(ctx: Ctx): Promise<number> {
  if (ctx.providers.board.name === "local") return 0; // the local board resolves directly
  const runs = await ctx.db.query<{ id: string; user_id: string; board_id: string }>(
    `SELECT id, user_id, board_id FROM runs WHERE board_id IS NOT NULL AND resolved_at IS NULL
       AND status <> ALL($1) ORDER BY updated_at DESC LIMIT 200`,
    [[RunStatus.Stopped, RunStatus.Failed]],
  );
  let resolved = 0;
  for (const r of runs) {
    try {
      if (await ctx.providers.board.isResolved(r.board_id)) {
        await resolveRun(ctx, r.id, r.user_id, ctx.providers.board.name);
        resolved += 1;
      }
    } catch (e) {
      ctx.log("board.resolved_poll_failed", { runId: r.id, error: String(e) });
    }
  }
  return resolved;
}

/** Worker: advance every due run, and pick up Resolved set on the board. */
export function startWorker(ctx: Ctx): () => void {
  let busy = false;
  let lastResolvedPoll = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const ids = await store.leaseDueRuns(ctx.db, [RunStatus.Running, RunStatus.NeedsUser], LEASE_SECONDS);
      for (const id of ids) {
        try {
          await advanceRun(ctx, id, { alreadyLeased: true });
        } catch (e) {
          ctx.log("worker.advance_failed", { runId: id, error: String(e) });
          await store.releaseRun(ctx.db, id);
        }
      }
      if (Date.now() - lastResolvedPoll >= ctx.cfg.RESOLVED_POLL_SECONDS * 1000) {
        lastResolvedPoll = Date.now();
        await pollBoardResolved(ctx);
      }
    } finally {
      busy = false;
    }
  };
  const handle = setInterval(() => void tick(), ctx.cfg.WORKER_INTERVAL_MS);
  void tick();
  return () => clearInterval(handle);
}
