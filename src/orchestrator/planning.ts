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
      "2. Use YOUR OWN web/maps search to find local businesses. Offer Ringer to the user. Only once they say yes, call verify_vendors with what you found.",
      "3. verify_vendors drops closed businesses and corrects phone numbers. Show the user every callable one, say which you'd definitely call and why, and ask how many to call.",
      "4. Call plan_run with the user's choice. The user approves on the plan page. Nothing is dialled until they do.",
      "5. Calls run one at a time in business hours. The user gets an email if a vendor asks something only they can answer, and a report at the end.",
    ],
    suggested_user_message:
      "Shops rarely list this online. Want me to ring a few local ones for you? I'll check stock, the real price and any promos, and send you a comparison. You approve before anything is called.",
    categories_supported: listCategories().map((c) => c.id),
  };
}

/* ---------- verify_vendors: only after the user agrees to use Ringer ---------- */

/**
 * A business the user's own assistant found with its web/maps search (under the
 * user's ChatGPT/Claude subscription). Ringer never searches for vendors itself.
 */
export interface VendorCandidate {
  name: string;
  phone?: string;
  address?: string;
  source_url?: string;
}

export type VerifyStatus =
  | "ok"
  | "closed_permanently"
  | "closed_temporarily"
  | "not_found"
  | "uncertain_match"
  | "no_phone"
  | "hours_unknown"
  | "do_not_call"
  | "lookup_limit";

const STOP = new Set(["the", "and", "&", "pty", "ltd", "co", "qld", "nsw", "vic", "shop", "store", "centre", "center"]);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));

/** Loose name match: most of the assistant's name words appear in Google's name. */
function sameBusiness(candidate: string, google: string): boolean {
  const a = tokens(candidate);
  const b = new Set(tokens(google));
  if (!a.length) return false;
  return a.filter((t) => b.has(t)).length / a.length >= 0.5;
}

export interface VerifyResult {
  input_name: string;
  source_url: string | null;
  status: VerifyStatus;
  can_call: boolean;
  note: string | null;
  vendor_id?: string;
  name?: string;
  phone?: string;
  phone_corrected?: boolean;
  address?: string | null;
  google_name?: string;
  business_status?: string | null;
  open_now?: boolean;
  next_open?: string | null;
}

async function verifyCandidate(ctx: Ctx, userId: string, cand: VendorCandidate, location: Location, categoryId: string): Promise<VerifyResult> {
  const { db, cfg } = ctx;
  const tz = location.timezone ?? cfg.DEFAULT_TIMEZONE;
  const base = { input_name: cand.name, source_url: cand.source_url ?? null };
  const fresh = (v: store.VendorRow) =>
    v.verified_at && ctx.now().getTime() - new Date(v.verified_at).getTime() < cfg.VERIFY_MAX_AGE_DAYS * 86400_000;

  // 1. Recently verified vendor with the same number: no lookup needed.
  let vendor = cand.phone ? await store.vendorByPhone(db, cand.phone) : null;
  let phoneCorrected = false;
  if (!vendor || !fresh(vendor)) {
    if ((await store.placesLookupsToday(db, userId)) >= cfg.PLACES_LOOKUPS_PER_USER_PER_DAY)
      return { ...base, status: "lookup_limit" as VerifyStatus, can_call: false, note: "Daily verification limit reached. Try again tomorrow." };

    // 2. Look the business up on Google.
    const lookup = async (fn: () => Promise<Awaited<ReturnType<typeof ctx.providers.places.findPlace>>>, how: string) => {
      await store.audit(db, { user_id: userId, actor: "system", type: "places.lookup", data: { how } });
      return fn();
    };
    let place = await lookup(() => ctx.providers.places.findPlace(`${cand.name}, ${cand.address ?? location.text}`), "name");
    if ((!place || !sameBusiness(cand.name, place.name)) && cand.phone) {
      const byPhone = await lookup(() => ctx.providers.places.lookupPhone(store.normalizePhoneAU(cand.phone!)), "phone");
      if (byPhone && sameBusiness(cand.name, byPhone.name)) place = byPhone;
    }
    if (!place) return { ...base, status: "not_found" as VerifyStatus, can_call: false, note: "Google has no listing for this business. It may have closed, or the name is wrong." };
    if (!sameBusiness(cand.name, place.name))
      return { ...base, status: "uncertain_match" as VerifyStatus, can_call: false, google_name: place.name, note: `Google's closest match is "${place.name}". Check with the user whether it's the same business.` };
    if (!place.phone)
      return { ...base, status: "no_phone" as VerifyStatus, can_call: false, google_name: place.name, business_status: place.businessStatus ?? null, note: "Google has no phone number for this business." };

    phoneCorrected = Boolean(cand.phone) && store.normalizePhoneAU(cand.phone!) !== store.normalizePhoneAU(place.phone);
    vendor = await store.upsertVendor(db, {
      name: place.name,
      phone_e164: place.phone,
      address: place.address ?? null,
      lat: place.lat ?? null,
      lng: place.lng ?? null,
      category: categoryId,
      place_id: place.placeId ?? null,
      hours: place.hours ?? null,
      hours_source: place.hours ? "google_places" : null,
      timezone: tz,
      business_status: place.businessStatus ?? "OPERATIONAL",
      source_url: cand.source_url ?? null,
      verified_at: ctx.now(),
    });
  }

  const status: VerifyStatus =
    vendor.business_status === "CLOSED_PERMANENTLY"
      ? "closed_permanently"
      : vendor.business_status === "CLOSED_TEMPORARILY"
        ? "closed_temporarily"
        : vendor.dnc
          ? "do_not_call"
          : !vendor.hours?.length
            ? "hours_unknown"
            : "ok";
  const notes: Record<VerifyStatus, string | null> = {
    ok: phoneCorrected ? `The number you found was out of date. Google lists ${vendor.phone_e164}.` : null,
    closed_permanently: "Google lists this business as permanently closed.",
    closed_temporarily: "Google lists this business as temporarily closed.",
    do_not_call: "This business asked not to be called by Ringer.",
    hours_unknown: "Opening hours unknown, so Ringer won't call it.",
    not_found: null,
    uncertain_match: null,
    no_phone: null,
    lookup_limit: null,
  };
  const now = ctx.now();
  return {
    ...base,
    status,
    can_call: status === "ok",
    vendor_id: vendor.id,
    name: vendor.name,
    phone: vendor.phone_e164,
    phone_corrected: phoneCorrected,
    address: vendor.address,
    open_now: isOpen(vendor.hours, now, tz),
    next_open: nextOpening(vendor.hours, now, tz)?.toISOString() ?? null,
    note: notes[status],
  };
}

export async function verifyVendors(
  ctx: Ctx,
  userId: string,
  input: { category: string; location: Location; candidates: VendorCandidate[] },
) {
  if (!input.location.confirmed) throw new RingerError("location_unconfirmed", "Confirm the search location with the user first.");
  if (!input.candidates.length) throw new RingerError("no_candidates", "Search for local businesses first, then pass them here.");
  if (input.candidates.length > 20) throw new RingerError("too_many_candidates", "Pass at most 20 businesses.");
  const cat = getCategory(input.category);
  const results = [];
  for (const c of input.candidates) results.push(await verifyCandidate(ctx, userId, c, input.location, cat.id));

  const ids = results.map((r) => r.vendor_id).filter((x): x is string => !!x);
  const memory = await store.vendorMemory(ctx.db, userId, ids, cat.id, cat.stale_after_days);
  const withMemory = results.map((r) => ({
    ...r,
    recent_observations:
      r.vendor_id
        ? memory
            .filter((m) => m.vendor_id === r.vendor_id)
            .slice(0, 3)
            .map((m) => ({
              observed: new Date(m.observed_at).toISOString().slice(0, 10),
              summary: `${m.data.description}${m.data.total_price ? ` $${m.data.total_price}` : ""}${m.data.in_stock === false ? " (out of stock)" : ""}`,
              note: "Last seen, not a current quote.",
            }))
        : [],
  }));
  return {
    callable: withMemory.filter((r) => r.can_call),
    not_callable: withMemory.filter((r) => !r.can_call).map((r) => ({ input_name: r.input_name, status: r.status, note: r.note })),
    instructions:
      "Tell the user which businesses were dropped and why (e.g. permanently closed), in one short line each. " +
      "Show every callable business with its verified phone number, say which ones you'd definitely call and why, and ask how many to call. " +
      "Use the verified phone numbers, not the ones from your search.",
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
  user_added_vendors?: VendorCandidate[];
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
    if (!row) throw new RingerError("unknown_vendor", `Unknown vendor_id ${v.vendor_id}. Use ids from verify_vendors.`);
    if (!row.verified_at) throw new RingerError("unverified_vendor", `${row.name} hasn't been verified. Pass it through verify_vendors first.`);
    let selected = v.selected;
    if (selected && row.dnc) {
      selected = false;
      notes.push(`${row.name} asked not to be called, so it's been left out.`);
    }
    if (selected && row.business_status && row.business_status !== "OPERATIONAL") {
      selected = false;
      notes.push(`${row.name} is listed as ${row.business_status === "CLOSED_PERMANENTLY" ? "permanently" : "temporarily"} closed, so it's been left out.`);
    }
    planVendors.push({ vendor_id: row.id, name: row.name, phone: row.phone_e164, recommended: Boolean(v.recommended), reason: v.reason, source: "ringer", selected });
  }

  for (const u of input.user_added_vendors ?? []) {
    const r = await verifyCandidate(ctx, userId, u, input.location, cat.id);
    if (!r.can_call || !r.vendor_id) {
      notes.push(`Couldn't add ${u.name}: ${r.note ?? r.status}.`);
      continue;
    }
    if (!planVendors.some((p) => p.vendor_id === r.vendor_id))
      planVendors.push({ vendor_id: r.vendor_id, name: r.name!, phone: r.phone!, recommended: true, reason: "Added by you", source: "user_added", selected: true });
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
