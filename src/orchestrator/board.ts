import { boardUrl, type Ctx } from "../core/context.js";
import * as store from "../core/store.js";
import type { Offer } from "../core/types.js";

/**
 * Projects Attentively's records onto the run board (Kolaboreyt, or the local board).
 * Board failures are logged and never block or lose a call.
 */
export async function ensureBoard(ctx: Ctx, runId: string): Promise<void> {
  const run = (await store.getRun(ctx.db, runId))!;
  if (run.board_id) return;
  try {
    const { boardId, shareUrl } = await ctx.providers.board.createBoard({
      runId,
      title: `Attentively: ${run.request.need.item}`,
      header: { request: run.request.text, location: run.location.text, status: run.status },
      columns: ["status", "price", "negotiated", "alternative", "earliest", "promo", "valid_until", "contact", "summary"],
    });
    const url = ctx.providers.board.name === "local" ? boardUrl(ctx, runId, run.user_id) : shareUrl;
    await store.setBoard(ctx.db, runId, boardId, url);
  } catch (e) {
    ctx.log("board.create_failed", { runId, error: String(e) });
  }
}

export async function syncBoard(ctx: Ctx, runId: string): Promise<void> {
  const run = (await store.getRun(ctx.db, runId))!;
  if (!run.board_id) return;
  try {
    const items = await store.runVendors(ctx.db, runId);
    const obs = await store.runObservations(ctx.db, runId);
    const calls = await store.runCalls(ctx.db, runId);
    for (const i of items.filter((x) => x.selected)) {
      const offers = obs.filter((o) => o.vendor_id === i.vendor_id).map((o) => o.data);
      const pick = (kind: Offer["kind"], phase?: Offer["phase"]) =>
        offers.filter((o) => o.kind === kind && (!phase || o.phase === phase)).at(-1);
      const last = [...calls].reverse().find((c) => c.vendor_id === i.vendor_id);
      const exact = pick("exact", "initial") ?? pick("exact", "written");
      await ctx.providers.board.upsertItem(run.board_id, {
        vendorId: i.vendor_id,
        name: i.vendor.name,
        phone: i.vendor.phone_e164,
        status: i.status,
        columns: {
          price: exact?.total_price ?? null,
          negotiated: pick("exact", "negotiated")?.total_price ?? null,
          alternative: pick("alternative") ? `${pick("alternative")!.description} $${pick("alternative")!.total_price ?? "?"}` : null,
          earliest: exact?.earliest_date ?? null,
          promo: exact?.promo ?? null,
          valid_until: exact?.valid_until ?? null,
          contact: last?.contact_name ?? null,
          summary: last?.summary ?? null,
        },
      });
    }
    await ctx.providers.board.updateHeader(run.board_id, { status: run.status });
  } catch (e) {
    ctx.log("board.sync_failed", { runId, error: String(e) });
  }
}
