import { boardUrl, type Ctx } from "../core/context.js";
import { describeNeed, personaOf } from "../core/persona.js";
import * as store from "../core/store.js";
import type { Offer, TranscriptTurn } from "../core/types.js";
import type { RunHeader } from "../providers/types.js";
import type { Report } from "./report.js";

/**
 * Projects Attentively's records onto the board (Kolaboreyt, or the local board).
 * The database stays the system of record: board failures are logged and never
 * block or lose a call.
 */

async function header(ctx: Ctx, runId: string): Promise<RunHeader> {
  const run = (await store.getRun(ctx.db, runId))!;
  const best = (run.report as Report | null)?.ranking?.best_overall ?? (run.report as Report | null)?.ranking?.cheapest_valid ?? null;
  return {
    title: `${describeNeed(run.request.need)}: ${run.location.text}`,
    status: run.resolved_at ? "resolved" : run.status,
    location: run.location.text,
    best_price: best?.offer.total_price ?? null,
    best_vendor: best?.vendor_name ?? null,
    // Reuse the link minted when the board record was created: signed links embed an
    // expiry, so minting a fresh one on every sync would rewrite the cell each time.
    report_url: run.board_url ?? boardUrl(ctx, runId, run.user_id),
  };
}

export async function ensureBoard(ctx: Ctx, runId: string): Promise<void> {
  const run = (await store.getRun(ctx.db, runId))!;
  if (run.board_id) return;
  try {
    // Emails and the board both link to Attentively's own board page (Kolaboreyt has no share links).
    const url = boardUrl(ctx, runId, run.user_id);
    await store.setBoard(ctx.db, runId, null, url);
    const { ref } = await ctx.providers.board.createRun(runId, await header(ctx, runId));
    await store.setBoard(ctx.db, runId, ref, url);
  } catch (e) {
    ctx.log("board.create_failed", { runId, error: String(e) });
  }
}

function callNote(ctx: Ctx, call: store.CallRow, assistant: string, vendorName: string): string | null {
  const transcript = (call.transcript as TranscriptTurn[] | null) ?? [];
  if (!call.summary && !transcript.length) return null;
  const mins = call.duration_sec ? `${Math.max(1, Math.round(call.duration_sec / 60))} min` : "";
  const head = [`${call.direction === "outbound" ? "📞 Call" : "📲 Callback"}`, mins, call.contact_name ? `spoke with ${call.contact_name}` : ""]
    .filter(Boolean)
    .join(" · ");
  const lines = transcript.map((t) => `${t.role === "agent" ? assistant : call.contact_name ?? vendorName}: ${t.text}`);
  return `${head}\n${call.summary ?? ""}\n\n${lines.join("\n")}`.trim();
}

export async function syncBoard(ctx: Ctx, runId: string): Promise<void> {
  const run = (await store.getRun(ctx.db, runId))!;
  if (!run.board_id) return;
  const board = ctx.providers.board;
  try {
    const items = await store.runVendors(ctx.db, runId);
    const obs = await store.runObservations(ctx.db, runId);
    const calls = await store.runCalls(ctx.db, runId);
    const user = (await store.getUser(ctx.db, run.user_id))!;
    const assistant = personaOf(user).assistant;

    for (const i of items.filter((x) => x.selected)) {
      const offers = obs.filter((o) => o.vendor_id === i.vendor_id).map((o) => o.data);
      const pick = (kind: Offer["kind"], phase?: Offer["phase"]) =>
        offers.filter((o) => o.kind === kind && (!phase || o.phase === phase)).at(-1);
      const vendorCalls = calls.filter((c) => c.vendor_id === i.vendor_id);
      const last = vendorCalls.at(-1);
      const exact = pick("exact", "initial") ?? pick("exact", "written");
      const alt = pick("alternative");
      await board.upsertVendor(run.board_id, runId, {
        vendorId: i.vendor_id,
        name: i.vendor.name,
        phone: i.vendor.phone_e164,
        status: i.status,
        columns: {
          price: exact?.total_price ?? null,
          negotiated: pick("exact", "negotiated")?.total_price ?? null,
          alternative: alt ? `${alt.description} $${alt.total_price ?? "?"}` : null,
          earliest: exact?.earliest_date ?? null,
          promo: exact?.promo ?? null,
          valid_until: exact?.valid_until ?? null,
          contact: last?.contact_name ?? null,
          summary: last?.summary ?? null,
        },
      });
      for (const c of vendorCalls.filter((c) => c.processed_at)) {
        const note = callNote(ctx, c, assistant, i.vendor.name);
        if (note) await board.postCallNote(run.board_id, runId, i.vendor_id, c.id, note);
      }
    }

    // Don't overwrite a Resolved someone set on the board; the poller will apply it.
    if (!run.resolved_at && (await board.isResolved(run.board_id))) return;
    await board.updateRun(run.board_id, runId, await header(ctx, runId));
  } catch (e) {
    ctx.log("board.sync_failed", { runId, error: String(e) });
  }
}
