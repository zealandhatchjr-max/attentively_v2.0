import { getCategory, guessCategory, listCategories, missingSpecs } from "../categories/index.js";
import { approvalUrl, boardUrl, type Ctx } from "../core/context.js";
import { isOpen, nextOpening } from "../core/hours.js";
import * as store from "../core/store.js";
import { DISCLOSURE } from "./script.js";
import { RingerError, RunStatus, VendorItemStatus, type Location, type Need, type Plan, type PlanVendor } from "../core/types.js";

/* ---------- check_local_inquiry: read-only, no auth ---------- */

export async function checkLocalInquiry(
  ctx: Ctx,
  input: { request: string; item?: string; location_text?: string; specs?: Record<string, string | number | boolean> },
) {
  const cat = guessCategory(`${input.request} ${input.item ?? ""}`);
  const loc = (input.location_text ?? "").toLowerCase();
  const coverage = !loc ? "unknown" : ctx.cfg.coverage.some((k) => loc.includes(k)) ? "covered" : "not_covered";
  const [{ n }] = await ctx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM observations WHERE category=$1 AND shareable AND observed_at > now() - ($2 || ' days')::interval`,
    [cat.id, String(cat.stale_after_days)],
  );
  const missing = missingSpecs(cat, { specs: input.specs ?? {} });
  return {
    fit: cat.id === "generic" ? "possible" : "strong",
    reason:
      cat.id === "generic"
        ? "Ringer can phone local businesses about any product or service where price or stock isn't published online."
        : `${cat.label}: local stock, fitted prices and promos are rarely online, so calling around is the reliable way to compare.`,
    category: cat.id,
    category_label: cat.label,
    required_details: cat.required_specs,
    missing_details: missing,
    coverage,
    coverage_note:
      coverage === "not_covered"
        ? "Ringer is piloting on the Gold Coast only. Tell the user it isn't available in their area yet."
        : coverage === "unknown"
          ? "Confirm the user's search location before planning. Never use a saved home address without asking."
          : "Location is inside the pilot area.",
    recent_shared_observations: Number(n),
    how_it_works: [
      "1. Confirm location and the exact item. Ask at most 3 questions, only ones that change who to call or what to ask.",
      "2. Call find_vendors, show the user ALL vendors found, say which you'd definitely call and why, and ask how many to call.",
      "3. Call plan_run with the user's choice. The user approves on the plan page. Nothing is dialled until they do.",
      "4. Calls run one at a time in business hours. The user gets an email if a vendor asks something only they can answer, and a report at the end.",
    ],
    suggested_user_message:
      "Shops rarely list this online. Want me to ring a few local ones for you? I'll check stock, the real price and any promos, and send you a comparison. You approve before anything is called.",
    categories_supported: listCategories().map((c) => c.id),
  };
}

/* ---------- find_vendors ---------- */

export async function findVendors(
  ctx: Ctx,
  userId: string,
  input: { category: string; search_query: string; location: Location },
) {
  if (!input.location.confirmed) throw new RingerError("location_unconfirmed", "Confirm the search location with the user first.");
  const cat = getCategory(input.category);
  const results = await ctx.providers.places.search(input.search_query, input.location.text);
  const now = ctx.now();
  const tz = input.location.timezone ?? ctx.cfg.DEFAULT_TIMEZONE;
  const vendors = [];
  for (const r of results) {
    const v = await store.upsertVendor(ctx.db, {
      name: r.name,
      phone_e164: r.phone,
      address: r.address ?? null,
      lat: r.lat ?? null,
      lng: r.lng ?? null,
      category: cat.id,
      place_id: r.placeId ?? null,
      hours: r.hours ?? null,
      hours_source: r.hours ? ctx.providers.places.constructor.name : null,
      timezone: tz,
    });
    vendors.push({ v, rating: r.rating });
  }
  const memory = await store.vendorMemory(ctx.db, userId, vendors.map((x) => x.v.id), cat.id, cat.stale_after_days);
  return {
    vendors: vendors.map(({ v, rating }) => {
      const mem = memory.filter((m) => m.vendor_id === v.id);
      return {
        vendor_id: v.id,
        name: v.name,
        phone: v.phone_e164,
        address: v.address,
        rating: rating ?? null,
        can_call: !v.dnc && Boolean(v.hours?.length),
        not_callable_reason: v.dnc ? "Asked not to be called" : !v.hours?.length ? "Opening hours unknown" : null,
        open_now: isOpen(v.hours, now, tz),
        next_open: nextOpening(v.hours, now, tz)?.toISOString() ?? null,
        recent_observations: mem.slice(0, 3).map((m) => ({
          observed: new Date(m.observed_at).toISOString().slice(0, 10),
          summary: `${m.data.description}${m.data.total_price ? ` $${m.data.total_price}` : ""}${m.data.in_stock === false ? " (out of stock)" : ""}`,
          note: "Last seen, not a current quote.",
        })),
      };
    }),
    instructions:
      "Show the user every vendor above. Recommend the ones you'd definitely call (with phone number and a short reason), then ask how many they want called. The user can also add their own vendors by phone number.",
  };
}

/* ---------- plan_run ---------- */

export interface PlanRunInput {
  request_text: string;
  category: string;
  location: Location;
  need: Need;
  extra_questions?: string[];
  vendors: Array<{ vendor_id: string; selected: boolean; recommended?: boolean; reason?: string }>;
  user_added_vendors?: Array<{ phone: string; name?: string }>;
  allow_negotiation?: boolean;
  notify_email?: string;
  host?: string;
}

export async function planRun(ctx: Ctx, userId: string, input: PlanRunInput) {
  const { db, cfg } = ctx;
  if (!input.location?.confirmed)
    throw new RingerError("location_unconfirmed", "The user must confirm the search location. Don't use a saved address without asking.");
  const cat = getCategory(input.category);
  const missing = missingSpecs(cat, input.need);
  if (missing.length) throw new RingerError("missing_details", `Ask the user for: ${missing.join("; ")}`);

  const user = (await store.getUser(db, userId))!;
  const planVendors: PlanVendor[] = [];
  const notes: string[] = [];

  for (const v of input.vendors) {
    const row = await store.getVendor(db, v.vendor_id);
    if (!row) throw new RingerError("unknown_vendor", `Unknown vendor_id ${v.vendor_id}. Use ids from find_vendors.`);
    let selected = v.selected;
    if (selected && row.dnc) {
      selected = false;
      notes.push(`${row.name} asked not to be called, so it's been left out.`);
    }
    planVendors.push({ vendor_id: row.id, name: row.name, phone: row.phone_e164, recommended: Boolean(v.recommended), reason: v.reason, source: "ringer", selected });
  }

  for (const u of input.user_added_vendors ?? []) {
    const place = await ctx.providers.places.lookupPhone(store.normalizePhoneAU(u.phone));
    if (!place || !place.hours?.length)
      throw new RingerError(
        "unverified_vendor",
        `Couldn't verify ${u.name ?? u.phone} (number or opening hours not found). Check the number with the user.`,
      );
    const row = await store.upsertVendor(db, {
      name: place.name,
      phone_e164: place.phone,
      address: place.address ?? null,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
      category: cat.id,
      place_id: place.placeId ?? null,
      hours: place.hours,
      hours_source: "places",
      timezone: input.location.timezone ?? cfg.DEFAULT_TIMEZONE,
    });
    if (row.dnc) {
      notes.push(`${row.name} asked not to be called, so it can't be added.`);
      continue;
    }
    if (!planVendors.some((p) => p.vendor_id === row.id))
      planVendors.push({ vendor_id: row.id, name: row.name, phone: row.phone_e164, recommended: true, reason: "Added by you", source: "user_added", selected: true });
  }

  // Recommended picks first, then the rest of the selected vendors, then unselected ones.
  planVendors.sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.recommended) - Number(a.recommended));
  const selected = planVendors.filter((p) => p.selected);
  if (!selected.length) throw new RingerError("no_vendors", "Select at least one vendor to call.");
  if (selected.length > cfg.MAX_CALLS_PER_RUN)
    throw new RingerError("too_many_vendors", `At most ${cfg.MAX_CALLS_PER_RUN} vendors can be called in one run.`);

  const estimated = Math.round(selected.length * cfg.EST_MINUTES_PER_CALL);
  const plan: Omit<Plan, "version"> = {
    round: 1,
    category: cat.id,
    location: input.location,
    need: input.need,
    questions: input.extra_questions ?? [],
    vendors: planVendors,
    calls_to_place: selected.length,
    allow_negotiation: input.allow_negotiation ?? true,
    estimated_minutes: estimated,
    notify_email: input.notify_email ?? user.email,
    disclosure: `${DISCLOSURE} Your details are never shared: vendors get your assistant's number and email.`,
  };
  const run = await store.createRun(db, { user_id: userId, host: input.host ?? "chatgpt", category: cat.id, text: input.request_text, plan });
  return planSummary(ctx, run.id, notes);
}

export async function planSummary(ctx: Ctx, runId: string, notes: string[] = []) {
  const run = (await store.getRun(ctx.db, runId))!;
  const plan = (await store.getPlan(ctx.db, runId))!;
  const user = (await store.getUser(ctx.db, run.user_id))!;
  const balanceMin = Math.floor(user.minutes_balance_seconds / 60);
  return {
    run_id: run.id,
    plan_version: plan.version,
    status: run.status,
    approval_url: approvalUrl(ctx, run.id, run.user_id, plan.version),
    location: plan.location.text,
    need: plan.need,
    calls_to_place: plan.calls_to_place,
    vendors_to_call: plan.vendors.filter((v) => v.selected).map((v) => ({ name: v.name, phone: v.phone, recommended: v.recommended, reason: v.reason, source: v.source })),
    vendors_not_called: plan.vendors.filter((v) => !v.selected).map((v) => v.name),
    questions_every_vendor: getCategory(plan.category).standard_questions(plan.need).concat(plan.questions),
    negotiation: plan.allow_negotiation
      ? "After getting each shop's own price, the assistant may mention the best real quote so far (shop name and price) to ask for a better deal."
      : "No negotiation.",
    estimated_minutes: plan.estimated_minutes,
    minutes_remaining: balanceMin,
    minutes_warning: plan.estimated_minutes > balanceMin ? "This run may use more minutes than remain. It will pause and ask if minutes run out." : null,
    notify_email: plan.notify_email,
    disclosure: plan.disclosure,
    notes,
    instructions:
      "Show the user this plan and the approval link. Calls start only after the user presses Approve on that page. You cannot approve for them.",
  };
}

/* ---------- request_action: follow-ups that need a new approval ---------- */

export async function requestAction(
  ctx: Ctx,
  userId: string,
  input: { run_id: string; action: "round_two" | "rerun_unanswered" | "call_more" | "export_csv"; vendor_ids?: string[] },
) {
  const { db } = ctx;
  const run = await store.getRunForUser(db, input.run_id, userId);
  if (input.action === "export_csv") return { csv: await exportCsv(ctx, run.id) };

  if (![RunStatus.Completed, RunStatus.Stopped].includes(run.status as any))
    throw new RingerError("run_active", "Follow-up calls can be planned once the current calls have finished.");
  const items = await store.runVendors(db, run.id);
  let ids: string[];
  if (input.action === "round_two") {
    const report = run.report as { round_two?: Array<{ vendor_id: string }> } | null;
    ids = input.vendor_ids?.length ? input.vendor_ids : (report?.round_two ?? []).map((r) => r.vendor_id);
  } else if (input.action === "rerun_unanswered") {
    ids = items.filter((i) => i.status === VendorItemStatus.NoAnswer || i.status === VendorItemStatus.Failed).map((i) => i.vendor_id);
  } else {
    ids = (input.vendor_ids ?? []).filter((id) => items.some((i) => i.vendor_id === id && i.status === VendorItemStatus.NotSelected));
  }
  ids = ids.filter((id) => !items.find((i) => i.vendor_id === id)?.vendor.dnc);
  if (!ids.length) throw new RingerError("nothing_to_do", "No vendors match that follow-up.");

  const prev = (await store.getPlan(db, run.id))!;
  const round = Math.max(...items.map((i) => i.round)) + (input.action === "call_more" ? 0 : 1);
  const plan: Omit<Plan, "version"> = {
    ...prev,
    round,
    vendors: items
      .filter((i) => ids.includes(i.vendor_id))
      .map((i) => ({ vendor_id: i.vendor_id, name: i.vendor.name, phone: i.vendor.phone_e164, recommended: i.recommended, reason: input.action.replace(/_/g, " "), source: i.source, selected: true })),
    calls_to_place: ids.length,
    allow_negotiation: input.action === "round_two" ? true : prev.allow_negotiation,
    estimated_minutes: Math.round(ids.length * ctx.cfg.EST_MINUTES_PER_CALL),
  };
  await store.addPlanVersion(db, run.id, plan);
  await store.setRunStatus(db, run.id, RunStatus.AwaitingApproval);
  await store.audit(db, { run_id: run.id, user_id: userId, actor: "model", type: "plan.follow_up_requested", data: { action: input.action, vendor_ids: ids } });
  return planSummary(ctx, run.id);
}

async function exportCsv(ctx: Ctx, runId: string): Promise<string> {
  const items = await store.runVendors(ctx.db, runId);
  const obs = await store.runObservations(ctx.db, runId);
  const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["vendor", "phone", "status", "kind", "phase", "description", "total_price", "earliest_date", "promo", "valid_until", "observed_at", "evidence"]];
  for (const i of items.filter((x) => x.selected)) {
    const offers = obs.filter((o) => o.vendor_id === i.vendor_id);
    if (!offers.length) rows.push([i.vendor.name, i.vendor.phone_e164, i.status, "", "", "", "", "", "", "", "", ""]);
    for (const o of offers)
      rows.push([i.vendor.name, i.vendor.phone_e164, i.status, o.kind, o.phase, o.data.description, String(o.data.total_price ?? ""), o.data.earliest_date ?? "", o.data.promo ?? "", o.data.valid_until ?? "", new Date(o.observed_at).toISOString(), o.evidence ?? ""]);
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

/* ---------- get_run view ---------- */

export async function runView(ctx: Ctx, runId: string) {
  const { db } = ctx;
  const run = (await store.getRun(db, runId))!;
  const items = await store.runVendors(db, runId);
  const obs = await store.runObservations(db, runId);
  const calls = await store.runCalls(db, runId);
  const open = await store.openCheckpoints(db, runId);
  return {
    run_id: run.id,
    status: run.status,
    request: run.request.text,
    location: run.location.text,
    plan_version: run.current_plan_version,
    brief_version: run.current_brief_version,
    approval_url: run.status === RunStatus.AwaitingApproval ? approvalUrl(ctx, run.id, run.user_id, run.current_plan_version) : null,
    board_url: boardUrl(ctx, run.id, run.user_id),
    next_action_at: run.next_action_at,
    pause_reason: run.pause_reason,
    vendors: items
      .filter((i) => i.selected)
      .map((i) => ({
        vendor_id: i.vendor_id,
        name: i.vendor.name,
        phone: i.vendor.phone_e164,
        status: i.status,
        source: i.source,
        offers: obs
          .filter((o) => o.vendor_id === i.vendor_id)
          .map((o) => ({ ...o.data, observed_at: o.observed_at, call_id: o.call_id })),
        calls: calls
          .filter((c) => c.vendor_id === i.vendor_id)
          .map((c) => ({ call_id: c.id, direction: c.direction, status: c.status, summary: c.summary, contact: c.contact_name, duration_sec: c.duration_sec, at: c.started_at })),
      })),
    needs_you: open.map((c) => ({
      checkpoint_id: c.id,
      vendor: items.find((i) => i.vendor_id === c.vendor_id)?.vendor.name,
      question: c.question,
      why: c.why_outside,
      answer_by: c.deadline_at,
    })),
    report: run.report,
    resolved: run.resolved_at !== null,
  };
}
