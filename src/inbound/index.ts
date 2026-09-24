import { getCategory } from "../categories/index.js";
import { boardUrl, type Ctx } from "../core/context.js";
import * as store from "../core/store.js";
import { RunStatus, type TranscriptTurn } from "../core/types.js";
import { syncBoard } from "../orchestrator/board.js";
import { sendReport } from "../orchestrator/report.js";

/**
 * Inbound handling for each user's hidden assistant identity: the phone number
 * (voice + SMS) and the email address vendors were given. Everything is answered
 * by the AI; known vendors are linked back to the run and the earlier call.
 */

export interface InboundCallContext {
  user_id: string | null;
  vendor_id: string | null;
  run_id: string | null;
  systemPrompt: string;
  firstMessage: string;
  dynamicVariables: Record<string, string>;
}

const RECEPTIONIST = `You are a polite, neutral, professional AI assistant answering a phone line on behalf of a customer.
Say you're an AI assistant and that the call is transcribed. Never share the customer's name, number or address.
Take a message: who is calling, what it's about, and how to reach them. Don't make commitments. Keep it brief.`;

export async function inboundCallStarted(
  ctx: Ctx,
  input: { agentNumber: string; callerNumber: string },
): Promise<InboundCallContext> {
  const user = await store.userByAssistantNumber(ctx.db, input.agentNumber);
  const base = { user_id: user?.id ?? null, vendor_id: null, run_id: null };
  const receptionist = {
    ...base,
    systemPrompt: RECEPTIONIST,
    firstMessage: "Hi, you've reached an AI assistant. This call is transcribed. How can I help?",
    dynamicVariables: {},
  };
  if (!user) return receptionist;
  const vendor = await store.vendorByPhone(ctx.db, input.callerNumber);
  if (!vendor) return receptionist;

  const runs = await store.runsWithVendor(ctx.db, user.id, vendor.id);
  if (!runs.length) return { ...receptionist, vendor_id: vendor.id };
  const run = runs[0];
  const calls = (await store.runCalls(ctx.db, run.id)).filter((c) => c.vendor_id === vendor.id);
  const last = calls.at(-1);
  const others = runs.slice(1).map((r) => r.request.need.item);

  if (run.resolved_at) {
    return {
      ...base,
      vendor_id: vendor.id,
      run_id: run.id,
      systemPrompt: `${RECEPTIONIST}\nThis is ${vendor.name} calling back about "${run.request.need.item}". The customer has already sorted this out. Thank them warmly, say no further information is needed, and end the call. Don't take new details.`,
      firstMessage: `Hi, thanks for calling back. I'm the AI assistant that called about the ${run.request.need.item}.`,
      dynamicVariables: { run_id: run.id, vendor_id: vendor.id },
    };
  }

  const notes = [
    last?.summary ? `Summary of our last call: ${last.summary}` : null,
    last?.contact_name ? `You spoke with ${last.contact_name}.` : null,
    ...(last?.transcript as TranscriptTurn[] | null ?? []).slice(-6).map((t) => `${t.role === "agent" ? "Assistant" : "Them"}: ${t.text}`),
  ].filter(Boolean);
  const cat = getCategory(run.category);

  return {
    ...base,
    vendor_id: vendor.id,
    run_id: run.id,
    systemPrompt: `${RECEPTIONIST}
This caller is ${vendor.name}, calling back about the customer's enquiry: "${run.request.text}" (${cat.label}).
Customer's need: ${JSON.stringify(run.request.need)}
${notes.join("\n")}
${others.length ? `If they're calling about something else, the customer also asked about: ${others.join(", ")}. Ask which one.` : ""}
Capture any new price, stock, date, promo and validity details precisely. You're gathering information only: no bookings or commitments.`,
    firstMessage: `Hi${last?.contact_name ? ` ${last.contact_name}` : ""}, thanks for calling back. I'm the AI assistant that called about the ${run.request.need.item}. This call is transcribed.`,
    dynamicVariables: { run_id: run.id, vendor_id: vendor.id },
  };
}

export async function inboundCallEnded(
  ctx: Ctx,
  input: { provider: string; providerCallId: string; agentNumber: string; callerNumber: string; durationSec: number; transcript: TranscriptTurn[] },
): Promise<void> {
  const user = await store.userByAssistantNumber(ctx.db, input.agentNumber);
  if (!user) {
    ctx.log("inbound.unknown_assistant_number", { agentNumber: input.agentNumber });
    return;
  }
  const ctxInfo = await inboundCallStarted(ctx, input);
  const callId = await store.insertInboundCall(ctx.db, {
    user_id: user.id,
    run_id: ctxInfo.run_id,
    vendor_id: ctxInfo.vendor_id,
    provider: input.provider,
    provider_call_id: input.providerCallId,
    caller_number: input.callerNumber,
  });
  const existing = await store.getCall(ctx.db, callId);
  if (existing?.processed_at) return; // webhook replay
  const seconds = Math.max(0, Math.round(input.durationSec));
  await store.chargeMinutes(ctx.db, user.id, seconds, "inbound_call", callId);
  await store.updateCall(ctx.db, callId, { status: "completed", duration_sec: seconds, seconds_charged: seconds, transcript: input.transcript, ended_at: ctx.now() });

  if (ctxInfo.run_id && ctxInfo.vendor_id) {
    const run = (await store.getRun(ctx.db, ctxInfo.run_id))!;
    const vendor = (await store.getVendor(ctx.db, ctxInfo.vendor_id))!;
    if (run.resolved_at) {
      await store.updateCall(ctx.db, callId, { summary: "Callback after the request was resolved; logged only.", processed_at: ctx.now() });
      return;
    }
    const { brief } = await store.getBrief(ctx.db, run.id);
    const ex = await ctx.providers.extractor.extract({
      category: run.category,
      vendorName: vendor.name,
      need: brief.need,
      questions: [],
      transcript: input.transcript,
      providerCallId: input.providerCallId,
    });
    await store.updateCall(ctx.db, callId, { extraction: ex, summary: ex.summary, contact_name: ex.contact_name ?? null });
    if (ex.offers.length)
      await store.addObservations(ctx.db, { run_id: run.id, call_id: callId, vendor_id: vendor.id, user_id: user.id, category: run.category, shareable: user.share_data_opt_in, offers: ex.offers });
    if (ex.do_not_call_requested) await store.setDoNotCall(ctx.db, vendor.id, "Asked on callback not to be called", `call:${callId}`);
    await store.updateCall(ctx.db, callId, { processed_at: ctx.now() });
    await store.audit(ctx.db, { run_id: run.id, actor: "vendor", type: "callback.received", data: { call_id: callId, vendor_id: vendor.id } });
    await syncBoard(ctx, run.id);
    await lateInfo(ctx, run.id);
    return;
  }

  // Unknown caller: pass the message on.
  const text = input.transcript.map((t) => `${t.role === "agent" ? "Assistant" : "Caller"}: ${t.text}`).join("\n");
  await store.updateCall(ctx.db, callId, { summary: "Message from an unknown caller", processed_at: ctx.now() });
  await ctx.providers.mailer.send({
    to: user.email,
    subject: `Message for you from ${input.callerNumber}`,
    text: `Someone called your assistant and left a message.\n\nCaller: ${input.callerNumber}\n\n${text}`,
  });
}

export async function inboundMessage(
  ctx: Ctx,
  input: { channel: "sms" | "email"; to: string; from: string; subject?: string; body: string },
): Promise<{ matched_run_id: string | null }> {
  const user =
    input.channel === "sms" ? await store.userByAssistantNumber(ctx.db, input.to) : await store.userByAssistantEmail(ctx.db, input.to);
  if (!user) {
    ctx.log("inbound.message_unknown_recipient", { channel: input.channel });
    return { matched_run_id: null };
  }

  // Match the sender to a vendor: by phone for SMS; by vendor name mentioned in an email.
  let vendor = input.channel === "sms" ? await store.vendorByPhone(ctx.db, input.from) : null;
  let run = null;
  if (vendor) run = (await store.runsWithVendor(ctx.db, user.id, vendor.id))[0] ?? null;
  if (!vendor && input.channel === "email") {
    const recent = await store.listRuns(ctx.db, user.id, 10);
    const hay = `${input.subject ?? ""} ${input.body} ${input.from}`.toLowerCase();
    for (const r of recent) {
      const hit = (await store.runVendors(ctx.db, r.id)).find((i) => i.selected && hay.includes(i.vendor.name.toLowerCase()));
      if (hit) {
        vendor = hit.vendor;
        run = r;
        break;
      }
    }
  }

  const msgId = await store.insertInboundMessage(ctx.db, {
    user_id: user.id,
    channel: input.channel,
    from_address: input.from,
    subject: input.subject,
    body: input.body,
    matched_vendor_id: vendor?.id ?? null,
    matched_run_id: run?.id ?? null,
  });

  if (!vendor || !run) {
    await ctx.providers.mailer.send({
      to: user.email,
      subject: `Message for you (${input.channel}) from ${input.from}`,
      text: `Your assistant received a ${input.channel === "sms" ? "text" : "email"} it couldn't match to one of your requests.\n\nFrom: ${input.from}\n${input.subject ? `Subject: ${input.subject}\n` : ""}\n${input.body}`,
    });
    return { matched_run_id: null };
  }
  if (run.resolved_at) {
    await store.audit(ctx.db, { run_id: run.id, actor: "vendor", type: "message.after_resolved", data: { message_id: msgId } });
    return { matched_run_id: run.id };
  }

  const offers = await ctx.providers.extractor.extractMessage({ category: run.category, vendorName: vendor.name, need: run.request.need, body: input.body });
  if (offers.length)
    await store.addObservations(ctx.db, { run_id: run.id, message_id: msgId, vendor_id: vendor.id, user_id: user.id, category: run.category, shareable: user.share_data_opt_in, offers });
  await store.audit(ctx.db, { run_id: run.id, actor: "vendor", type: "message.received", data: { message_id: msgId, channel: input.channel, offers: offers.length } });
  await syncBoard(ctx, run.id);
  await lateInfo(ctx, run.id);
  return { matched_run_id: run.id };
}

/** Late info always triggers an updated report once the report has gone out, unless Resolved. */
async function lateInfo(ctx: Ctx, runId: string): Promise<void> {
  const run = (await store.getRun(ctx.db, runId))!;
  if (run.resolved_at) return;
  const calling = run.status === RunStatus.Running || run.status === RunStatus.NeedsUser;
  if (run.report_sent_at && !calling) {
    await sendReport(ctx, runId, { updated: true });
  } else {
    // Still calling: the new info is on the board and goes into the final report.
    ctx.log("inbound.late_info_folded_into_active_run", { runId, board: boardUrl(ctx, runId, run.user_id) });
  }
}
