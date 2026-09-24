import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import {
  newId,
  type Brief,
  type Location,
  type OpeningHours,
  type Plan,
  RunStatus,
  VendorItemStatus,
  type Offer,
  RingerError,
} from "./types.js";

/* ---------- row types ---------- */

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  assistant_number: string | null;
  voice_phone_number_id: string | null;
  assistant_email: string | null;
  minutes_balance_seconds: number;
  share_data_opt_in: boolean;
}

export interface VendorRow {
  id: string;
  name: string;
  phone_e164: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  category: string | null;
  place_id: string | null;
  hours: OpeningHours | null;
  hours_source: string | null;
  timezone: string | null;
  dnc: boolean;
  dnc_reason: string | null;
  business_status: string | null;
  verified_at: Date | null;
  source_url: string | null;
}

export interface RunRow {
  id: string;
  user_id: string;
  host: string;
  status: RunStatus;
  category: string;
  request: { text: string; need: Plan["need"]; notify_email: string };
  location: Location;
  current_plan_version: number;
  current_brief_version: number;
  next_action_at: Date | null;
  board_id: string | null;
  board_url: string | null;
  report: unknown;
  report_sent_at: Date | null;
  resolved_at: Date | null;
  pause_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunVendorRow {
  run_id: string;
  vendor_id: string;
  position: number;
  status: VendorItemStatus;
  source: "ringer" | "user_added";
  recommended: boolean;
  reason: string | null;
  selected: boolean;
  plan_version: number;
  round: number;
}

export interface CallRow {
  id: string;
  run_id: string | null;
  vendor_id: string | null;
  user_id: string;
  direction: "outbound" | "inbound";
  attempt_no: number;
  round: number;
  plan_version: number | null;
  brief_version: number | null;
  provider: string;
  provider_call_id: string | null;
  status: string;
  failure_reason: string | null;
  caller_number: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_sec: number | null;
  transcript: unknown;
  summary: string | null;
  contact_name: string | null;
  extraction: unknown;
  leverage: unknown;
  negotiation_check: unknown;
  seconds_charged: number;
  processed_at: Date | null;
}

export interface ObservationRow {
  id: string;
  run_id: string | null;
  call_id: string | null;
  message_id: string | null;
  vendor_id: string;
  user_id: string;
  category: string;
  offer_key: string;
  kind: "exact" | "alternative";
  phase: "initial" | "negotiated" | "written";
  data: Offer;
  evidence: string | null;
  confidence: string;
  observed_at: Date;
  valid_until: Date | null;
  shareable: boolean;
}

export interface CheckpointRow {
  id: string;
  run_id: string;
  call_id: string | null;
  vendor_id: string | null;
  question: string;
  why_outside: string | null;
  status: "open" | "answered" | "skipped";
  answer: string | null;
  deadline_at: Date;
  created_at: Date;
}

const j = (v: unknown) => JSON.stringify(v);
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/* ---------- audit ---------- */

export async function audit(
  db: Db,
  e: { run_id?: string | null; user_id?: string | null; actor: "user" | "model" | "system" | "vendor"; type: string; data?: unknown },
): Promise<void> {
  await db.query(`INSERT INTO audit_events (run_id, user_id, actor, type, data) VALUES ($1,$2,$3,$4,$5)`, [
    e.run_id ?? null,
    e.user_id ?? null,
    e.actor,
    e.type,
    e.data === undefined ? null : j(e.data),
  ]);
}

export async function auditEvents(db: Db, runId: string) {
  return db.query<{ actor: string; type: string; data: unknown; at: Date }>(
    `SELECT actor, type, data, at FROM audit_events WHERE run_id=$1 ORDER BY id`,
    [runId],
  );
}

/* ---------- users ---------- */

export async function createUser(
  db: Db,
  u: { email: string; display_name?: string; minutes_seconds?: number; share_data_opt_in?: boolean },
): Promise<{ user: UserRow; apiToken: string }> {
  const id = newId("usr");
  const apiToken = `rg_${randomBytes(24).toString("base64url")}`;
  await db.query(
    `INSERT INTO users (id, email, display_name, api_token_hash, minutes_balance_seconds, share_data_opt_in)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, u.email, u.display_name ?? null, hashToken(apiToken), u.minutes_seconds ?? 0, u.share_data_opt_in ?? false],
  );
  if (u.minutes_seconds) {
    await db.query(`INSERT INTO minutes_ledger (id, user_id, delta_sec, reason) VALUES ($1,$2,$3,'grant')`, [
      newId("led"),
      id,
      u.minutes_seconds,
    ]);
  }
  return { user: (await getUser(db, id))!, apiToken };
}

export async function getUser(db: Db, id: string): Promise<UserRow | null> {
  return (await db.query<UserRow>(`SELECT * FROM users WHERE id=$1`, [id]))[0] ?? null;
}

export async function userByToken(db: Db, token: string): Promise<UserRow | null> {
  return (await db.query<UserRow>(`SELECT * FROM users WHERE api_token_hash=$1`, [hashToken(token)]))[0] ?? null;
}

export async function userByAssistantNumber(db: Db, number: string): Promise<UserRow | null> {
  return (await db.query<UserRow>(`SELECT * FROM users WHERE assistant_number=$1`, [number]))[0] ?? null;
}

export async function userByAssistantEmail(db: Db, email: string): Promise<UserRow | null> {
  return (
    await db.query<UserRow>(`SELECT * FROM users WHERE lower(assistant_email)=lower($1)`, [email])
  )[0] ?? null;
}

export async function setAssistantIdentity(
  db: Db,
  userId: string,
  a: { number: string; voice_phone_number_id?: string; email: string },
) {
  await db.query(
    `UPDATE users SET assistant_number=$2, voice_phone_number_id=$3, assistant_email=$4 WHERE id=$1`,
    [userId, a.number, a.voice_phone_number_id ?? null, a.email],
  );
}

export async function chargeMinutes(db: Db, userId: string, seconds: number, reason: string, callId?: string) {
  if (seconds <= 0) return;
  await db.query(`UPDATE users SET minutes_balance_seconds = minutes_balance_seconds - $2 WHERE id=$1`, [
    userId,
    seconds,
  ]);
  await db.query(`INSERT INTO minutes_ledger (id, user_id, delta_sec, reason, call_id) VALUES ($1,$2,$3,$4,$5)`, [
    newId("led"),
    userId,
    -seconds,
    reason,
    callId ?? null,
  ]);
}

export async function grantMinutes(db: Db, userId: string, seconds: number, reason: string) {
  await db.query(`UPDATE users SET minutes_balance_seconds = minutes_balance_seconds + $2 WHERE id=$1`, [
    userId,
    seconds,
  ]);
  await db.query(`INSERT INTO minutes_ledger (id, user_id, delta_sec, reason) VALUES ($1,$2,$3,$4)`, [
    newId("led"),
    userId,
    seconds,
    reason,
  ]);
}

/* ---------- vendors ---------- */

export function normalizePhoneAU(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("61")) return `+${digits}`;
  if (digits.startsWith("0")) return `+61${digits.slice(1)}`;
  return `+61${digits}`;
}

export async function upsertVendor(
  db: Db,
  v: Omit<VendorRow, "id" | "dnc" | "dnc_reason" | "business_status" | "verified_at" | "source_url"> & {
    id?: string;
    business_status?: string | null;
    verified_at?: Date | null;
    source_url?: string | null;
  },
): Promise<VendorRow> {
  const phone = normalizePhoneAU(v.phone_e164);
  const existing = (await db.query<VendorRow>(`SELECT * FROM vendors WHERE phone_e164=$1`, [phone]))[0];
  if (existing) {
    await db.query(
      `UPDATE vendors SET name=$2, address=COALESCE($3,address), lat=COALESCE($4,lat), lng=COALESCE($5,lng),
         category=COALESCE($6,category), place_id=COALESCE($7,place_id), hours=COALESCE($8,hours),
         hours_source=COALESCE($9,hours_source), timezone=COALESCE($10,timezone),
         business_status=COALESCE($11,business_status), source_url=COALESCE($12,source_url),
         verified_at=COALESCE($13, verified_at), updated_at=now()
       WHERE id=$1`,
      [existing.id, v.name, v.address, v.lat, v.lng, v.category, v.place_id, v.hours ? j(v.hours) : null, v.hours_source, v.timezone, v.business_status ?? null, v.source_url ?? null, v.verified_at ?? null],
    );
    return (await getVendor(db, existing.id))!;
  }
  const id = v.id ?? newId("ven");
  await db.query(
    `INSERT INTO vendors (id, name, phone_e164, address, lat, lng, category, place_id, hours, hours_source, timezone, business_status, source_url, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, v.name, phone, v.address, v.lat, v.lng, v.category, v.place_id, v.hours ? j(v.hours) : null, v.hours_source, v.timezone, v.business_status ?? null, v.source_url ?? null, v.verified_at ?? null],
  );
  return (await getVendor(db, id))!;
}

export async function vendorByPlaceId(db: Db, placeId: string): Promise<VendorRow | null> {
  return (await db.query<VendorRow>(`SELECT * FROM vendors WHERE place_id=$1`, [placeId]))[0] ?? null;
}

/** Places lookups by this user in the last 24h (cost cap). */
export async function placesLookupsToday(db: Db, userId: string): Promise<number> {
  return Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_events WHERE user_id=$1 AND type='places.lookup' AND at > now() - interval '1 day'`,
        [userId],
      )
    )[0].n,
  );
}

export async function getVendor(db: Db, id: string): Promise<VendorRow | null> {
  return (await db.query<VendorRow>(`SELECT * FROM vendors WHERE id=$1`, [id]))[0] ?? null;
}

export async function vendorByPhone(db: Db, phone: string): Promise<VendorRow | null> {
  return (await db.query<VendorRow>(`SELECT * FROM vendors WHERE phone_e164=$1`, [normalizePhoneAU(phone)]))[0] ?? null;
}

export async function setDoNotCall(db: Db, vendorId: string, reason: string, source: string) {
  await db.query(`UPDATE vendors SET dnc=TRUE, dnc_reason=$2, dnc_source=$3, dnc_at=now() WHERE id=$1`, [
    vendorId,
    reason,
    source,
  ]);
}

/* ---------- runs, plans, briefs ---------- */

export async function createRun(
  db: Db,
  r: { user_id: string; host: string; category: string; text: string; plan: Omit<Plan, "version"> },
): Promise<RunRow> {
  const id = newId("run");
  await db.tx(async (t) => {
    await t.query(
      `INSERT INTO runs (id, user_id, host, status, category, request, location, current_plan_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0)`,
      [
        id,
        r.user_id,
        r.host,
        RunStatus.AwaitingApproval,
        r.category,
        j({ text: r.text, need: r.plan.need, notify_email: r.plan.notify_email }),
        j(r.plan.location),
      ],
    );
    await addPlanVersion(t, id, r.plan);
    await addBriefVersion(
      t,
      id,
      { need: r.plan.need, questions: r.plan.questions, resolved_answers: [], learned_facts: [], allow_negotiation: r.plan.allow_negotiation },
      "initial plan",
    );
  });
  await audit(db, { run_id: id, user_id: r.user_id, actor: "model", type: "run.planned", data: { host: r.host } });
  return (await getRun(db, id))!;
}

/** Writes a new plan version and syncs the run's vendor list to it. */
export async function addPlanVersion(db: Db, runId: string, plan: Omit<Plan, "version">): Promise<number> {
  const [{ v }] = await db.query<{ v: number }>(
    `SELECT COALESCE(MAX(version),0)+1 AS v FROM plan_versions WHERE run_id=$1`,
    [runId],
  );
  const full: Plan = { ...plan, version: v };
  await db.query(`INSERT INTO plan_versions (run_id, version, plan) VALUES ($1,$2,$3)`, [runId, v, j(full)]);
  let pos = (
    await db.query<{ p: number }>(`SELECT COALESCE(MAX(position),0) AS p FROM run_vendors WHERE run_id=$1`, [runId])
  )[0].p;
  for (const pv of plan.vendors) {
    const existing = (
      await db.query<RunVendorRow>(`SELECT * FROM run_vendors WHERE run_id=$1 AND vendor_id=$2`, [runId, pv.vendor_id])
    )[0];
    if (existing) {
      // A later plan version (round 2, rerun) re-queues selected vendors for a new round.
      if (pv.selected) {
        await db.query(
          `UPDATE run_vendors SET status=$3, selected=TRUE, plan_version=$4, round=$5, reason=COALESCE($6,reason), updated_at=now()
           WHERE run_id=$1 AND vendor_id=$2`,
          [runId, pv.vendor_id, VendorItemStatus.Queued, v, plan.round, pv.reason ?? null],
        );
      }
      continue;
    }
    pos += 1;
    await db.query(
      `INSERT INTO run_vendors (run_id, vendor_id, position, status, source, recommended, reason, selected, plan_version, round)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        runId,
        pv.vendor_id,
        pos,
        pv.selected ? VendorItemStatus.Queued : VendorItemStatus.NotSelected,
        pv.source,
        pv.recommended,
        pv.reason ?? null,
        pv.selected,
        v,
        plan.round,
      ],
    );
  }
  await db.query(`UPDATE runs SET current_plan_version=$2, updated_at=now() WHERE id=$1`, [runId, v]);
  return v;
}

export async function getPlan(db: Db, runId: string, version?: number): Promise<Plan | null> {
  const rows = await db.query<{ plan: Plan }>(
    version
      ? `SELECT plan FROM plan_versions WHERE run_id=$1 AND version=$2`
      : `SELECT plan FROM plan_versions WHERE run_id=$1 ORDER BY version DESC LIMIT 1`,
    version ? [runId, version] : [runId],
  );
  return rows[0]?.plan ?? null;
}

export async function addBriefVersion(db: Db, runId: string, brief: Brief, reason: string): Promise<number> {
  const [{ v }] = await db.query<{ v: number }>(
    `SELECT COALESCE(MAX(version),0)+1 AS v FROM brief_versions WHERE run_id=$1`,
    [runId],
  );
  await db.query(`INSERT INTO brief_versions (run_id, version, brief, reason) VALUES ($1,$2,$3,$4)`, [
    runId,
    v,
    j(brief),
    reason,
  ]);
  await db.query(`UPDATE runs SET current_brief_version=$2, updated_at=now() WHERE id=$1`, [runId, v]);
  return v;
}

export async function getBrief(db: Db, runId: string): Promise<{ version: number; brief: Brief }> {
  const row = (
    await db.query<{ version: number; brief: Brief }>(
      `SELECT version, brief FROM brief_versions WHERE run_id=$1 ORDER BY version DESC LIMIT 1`,
      [runId],
    )
  )[0];
  if (!row) throw new RingerError("no_brief", `Run ${runId} has no brief`);
  return row;
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  return (await db.query<RunRow>(`SELECT * FROM runs WHERE id=$1`, [id]))[0] ?? null;
}

export async function getRunForUser(db: Db, id: string, userId: string): Promise<RunRow> {
  const run = await getRun(db, id);
  if (!run || run.user_id !== userId) throw new RingerError("not_found", "Run not found");
  return run;
}

export async function listRuns(db: Db, userId: string, limit = 20): Promise<RunRow[]> {
  return db.query<RunRow>(`SELECT * FROM runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
}

export async function setRunStatus(
  db: Db,
  runId: string,
  status: RunStatus,
  opts: { next_action_at?: Date | null; pause_reason?: string | null } = {},
) {
  await db.query(
    `UPDATE runs SET status=$2, next_action_at=$3, pause_reason=$4, updated_at=now() WHERE id=$1`,
    [runId, status, opts.next_action_at ?? null, opts.pause_reason ?? null],
  );
}

export async function scheduleRun(db: Db, runId: string, at: Date) {
  await db.query(`UPDATE runs SET next_action_at=$2, updated_at=now() WHERE id=$1`, [runId, at]);
}

export async function setBoard(db: Db, runId: string, boardId: string, boardUrl: string) {
  await db.query(`UPDATE runs SET board_id=$2, board_url=$3 WHERE id=$1`, [runId, boardId, boardUrl]);
}

export async function setReport(db: Db, runId: string, report: unknown, sent: boolean) {
  await db.query(
    `UPDATE runs SET report=$2, report_sent_at=CASE WHEN $3 THEN now() ELSE report_sent_at END, updated_at=now() WHERE id=$1`,
    [runId, j(report), sent],
  );
}

/** Lease a due run so only one worker advances it at a time. */
export async function leaseDueRuns(db: Db, statuses: RunStatus[], leaseSeconds: number, limit = 10): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `UPDATE runs SET locked_until = now() + ($3 || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM runs
       WHERE status = ANY($1) AND next_action_at IS NOT NULL AND next_action_at <= now()
         AND (locked_until IS NULL OR locked_until < now())
       ORDER BY next_action_at LIMIT $2
     ) RETURNING id`,
    [statuses, limit, String(leaseSeconds)],
  );
  return rows.map((r) => r.id);
}

export async function leaseRun(db: Db, runId: string, leaseSeconds: number): Promise<boolean> {
  const rows = await db.query(
    `UPDATE runs SET locked_until = now() + ($2 || ' seconds')::interval
     WHERE id=$1 AND (locked_until IS NULL OR locked_until < now()) RETURNING id`,
    [runId, String(leaseSeconds)],
  );
  return rows.length > 0;
}

export async function releaseRun(db: Db, runId: string) {
  await db.query(`UPDATE runs SET locked_until=NULL WHERE id=$1`, [runId]);
}

/* ---------- approvals ---------- */

export async function recordApproval(
  db: Db,
  a: { run_id: string; plan_version: number; user_id: string; method: string },
): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO approvals (id, run_id, plan_version, user_id, method) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (run_id, plan_version) DO NOTHING RETURNING id`,
    [newId("apr"), a.run_id, a.plan_version, a.user_id, a.method],
  );
  return rows.length > 0;
}

export async function hasApproval(db: Db, runId: string, planVersion: number): Promise<boolean> {
  return (
    (await db.query(`SELECT 1 FROM approvals WHERE run_id=$1 AND plan_version=$2`, [runId, planVersion])).length > 0
  );
}

/* ---------- run vendors ---------- */

export async function runVendors(db: Db, runId: string): Promise<Array<RunVendorRow & { vendor: VendorRow }>> {
  const rows = await db.query<RunVendorRow & { v: VendorRow }>(
    `SELECT rv.*, to_jsonb(v) AS v FROM run_vendors rv JOIN vendors v ON v.id = rv.vendor_id
     WHERE rv.run_id=$1 ORDER BY rv.position`,
    [runId],
  );
  return rows.map(({ v, ...rv }) => ({ ...rv, vendor: v }));
}

export async function setVendorItemStatus(db: Db, runId: string, vendorId: string, status: VendorItemStatus) {
  await db.query(`UPDATE run_vendors SET status=$3, updated_at=now() WHERE run_id=$1 AND vendor_id=$2`, [
    runId,
    vendorId,
    status,
  ]);
}

/* ---------- calls ---------- */

/**
 * Inserts the call row BEFORE dialing. The unique index makes a second dial for the
 * same (run, vendor, round, attempt) impossible, even across retries and restarts.
 */
export async function reserveOutboundCall(
  db: Db,
  c: { run_id: string; vendor_id: string; user_id: string; round: number; attempt_no: number; plan_version: number; brief_version: number; provider: string; leverage: unknown },
): Promise<string | null> {
  const id = newId("call");
  const rows = await db.query(
    `INSERT INTO calls (id, run_id, vendor_id, user_id, direction, attempt_no, round, plan_version, brief_version, provider, status, leverage)
     VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,$9,'dialing',$10)
     ON CONFLICT DO NOTHING RETURNING id`,
    [id, c.run_id, c.vendor_id, c.user_id, c.attempt_no, c.round, c.plan_version, c.brief_version, c.provider, j(c.leverage)],
  );
  return rows.length ? id : null;
}

export async function updateCall(db: Db, id: string, patch: Partial<Omit<CallRow, "id">>) {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  const jsonCols = new Set(["transcript", "extraction", "leverage", "negotiation_check"]);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  const vals = keys.map((k) => (jsonCols.has(k) && patch[k] != null ? j(patch[k]) : patch[k]));
  await db.query(`UPDATE calls SET ${sets} WHERE id=$1`, [id, ...vals]);
}

export async function insertInboundCall(
  db: Db,
  c: { user_id: string; run_id: string | null; vendor_id: string | null; provider: string; provider_call_id: string; caller_number: string },
): Promise<string> {
  const existing = (
    await db.query<{ id: string }>(`SELECT id FROM calls WHERE provider=$1 AND provider_call_id=$2`, [c.provider, c.provider_call_id])
  )[0];
  if (existing) return existing.id;
  const id = newId("call");
  await db.query(
    `INSERT INTO calls (id, run_id, vendor_id, user_id, direction, provider, provider_call_id, status, caller_number)
     VALUES ($1,$2,$3,$4,'inbound',$5,$6,'in_progress',$7)`,
    [id, c.run_id, c.vendor_id, c.user_id, c.provider, c.provider_call_id, c.caller_number],
  );
  return id;
}

export async function getCall(db: Db, id: string): Promise<CallRow | null> {
  return (await db.query<CallRow>(`SELECT * FROM calls WHERE id=$1`, [id]))[0] ?? null;
}

export async function callByProviderId(db: Db, provider: string, providerCallId: string): Promise<CallRow | null> {
  return (
    await db.query<CallRow>(`SELECT * FROM calls WHERE provider=$1 AND provider_call_id=$2`, [provider, providerCallId])
  )[0] ?? null;
}

export async function runCalls(db: Db, runId: string): Promise<CallRow[]> {
  return db.query<CallRow>(`SELECT * FROM calls WHERE run_id=$1 ORDER BY started_at`, [runId]);
}

export async function activeOutboundCall(db: Db, runId: string): Promise<CallRow | null> {
  return (
    await db.query<CallRow>(
      `SELECT * FROM calls WHERE run_id=$1 AND direction='outbound' AND processed_at IS NULL ORDER BY started_at LIMIT 1`,
      [runId],
    )
  )[0] ?? null;
}

export async function outboundCallCount(db: Db, runId: string): Promise<number> {
  return Number(
    (await db.query<{ n: string }>(`SELECT count(*) AS n FROM calls WHERE run_id=$1 AND direction='outbound'`, [runId]))[0].n,
  );
}

export async function attemptsFor(db: Db, runId: string, vendorId: string, round: number): Promise<number> {
  return Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM calls WHERE run_id=$1 AND vendor_id=$2 AND round=$3 AND direction='outbound'`,
        [runId, vendorId, round],
      )
    )[0].n,
  );
}

/* ---------- observations ---------- */

export async function addObservations(
  db: Db,
  o: { run_id: string | null; call_id?: string; message_id?: string; vendor_id: string; user_id: string; category: string; shareable: boolean; offers: Offer[] },
) {
  for (const offer of o.offers) {
    const offerKey = newId("off");
    await db.query(
      `INSERT INTO observations (id, run_id, call_id, message_id, vendor_id, user_id, category, offer_key, kind, phase, data, evidence, valid_until, shareable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        newId("obs"),
        o.run_id,
        o.call_id ?? null,
        o.message_id ?? null,
        o.vendor_id,
        o.user_id,
        o.category,
        offerKey,
        offer.kind,
        offer.phase,
        j(offer),
        offer.evidence ?? null,
        offer.valid_until ? new Date(offer.valid_until) : null,
        o.shareable,
      ],
    );
  }
}

export async function runObservations(db: Db, runId: string): Promise<ObservationRow[]> {
  return db.query<ObservationRow>(`SELECT * FROM observations WHERE run_id=$1 ORDER BY observed_at`, [runId]);
}

/**
 * Vendor memory visible to a user: their own observations, plus other users'
 * observations they opted in to share — returned without any link to who asked.
 */
export async function vendorMemory(
  db: Db,
  userId: string,
  vendorIds: string[],
  category: string,
  sinceDays: number,
): Promise<Array<{ vendor_id: string; data: Offer; observed_at: Date; own: boolean }>> {
  if (!vendorIds.length) return [];
  return db.query(
    `SELECT vendor_id, data, observed_at, (user_id = $1) AS own FROM observations
     WHERE vendor_id = ANY($2) AND category=$3 AND observed_at > now() - ($4 || ' days')::interval
       AND (user_id = $1 OR shareable)
     ORDER BY observed_at DESC LIMIT 50`,
    [userId, vendorIds, category, String(sinceDays)],
  );
}

/* ---------- checkpoints ---------- */

export async function createCheckpoint(
  db: Db,
  c: { run_id: string; call_id: string; vendor_id: string; question: string; why_outside: string; deadline_at: Date },
): Promise<string> {
  const id = newId("chk");
  await db.query(
    `INSERT INTO checkpoints (id, run_id, call_id, vendor_id, question, why_outside, status, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7)`,
    [id, c.run_id, c.call_id, c.vendor_id, c.question, c.why_outside, c.deadline_at],
  );
  return id;
}

export async function openCheckpoints(db: Db, runId: string): Promise<CheckpointRow[]> {
  return db.query<CheckpointRow>(`SELECT * FROM checkpoints WHERE run_id=$1 AND status='open' ORDER BY created_at`, [runId]);
}

export async function allCheckpoints(db: Db, runId: string): Promise<CheckpointRow[]> {
  return db.query<CheckpointRow>(`SELECT * FROM checkpoints WHERE run_id=$1 ORDER BY created_at`, [runId]);
}

export async function resolveCheckpoint(db: Db, id: string, status: "answered" | "skipped", answer?: string) {
  const rows = await db.query(
    `UPDATE checkpoints SET status=$2, answer=$3, resolved_at=now() WHERE id=$1 AND status='open' RETURNING id`,
    [id, status, answer ?? null],
  );
  return rows.length > 0;
}

/* ---------- inbound messages ---------- */

export async function insertInboundMessage(
  db: Db,
  m: { user_id: string; channel: "sms" | "email"; from_address: string; subject?: string; body: string; matched_vendor_id: string | null; matched_run_id: string | null },
): Promise<string> {
  const id = newId("msg");
  await db.query(
    `INSERT INTO inbound_messages (id, user_id, channel, from_address, subject, body, matched_vendor_id, matched_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, m.user_id, m.channel, m.from_address, m.subject ?? null, m.body, m.matched_vendor_id, m.matched_run_id],
  );
  return id;
}

/** Runs of this user that involved this vendor, most recent first. */
export async function runsWithVendor(db: Db, userId: string, vendorId: string): Promise<RunRow[]> {
  return db.query<RunRow>(
    `SELECT r.* FROM runs r JOIN run_vendors rv ON rv.run_id = r.id
     WHERE r.user_id=$1 AND rv.vendor_id=$2 ORDER BY r.created_at DESC LIMIT 5`,
    [userId, vendorId],
  );
}
