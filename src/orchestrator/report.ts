import { boardUrl, type Ctx } from "../core/context.js";
import { rank, roundTwoCandidates, type Ranking, type RankedOffer } from "../core/ranking.js";
import * as store from "../core/store.js";
import type { Offer } from "../core/types.js";

export interface Report {
  run_id: string;
  generated_at: string;
  request: string;
  ranking: Ranking;
  vendors: Array<{ name: string; phone: string; status: string; summary?: string; contact?: string }>;
  unanswered_questions: Array<{ vendor: string; question: string }>;
  round_two: Array<{ vendor_id: string; vendor_name: string; their_total: number; best_total: number }>;
  next_step: string;
  negotiation_flags: string[];
}

export async function buildReport(ctx: Ctx, runId: string): Promise<Report> {
  const { db } = ctx;
  const run = (await store.getRun(db, runId))!;
  const items = await store.runVendors(db, runId);
  const obs = await store.runObservations(db, runId);
  const calls = await store.runCalls(db, runId);
  const checkpoints = await store.allCheckpoints(db, runId);
  const need = run.request.need;

  const byVendor = new Map<string, Offer[]>();
  for (const o of obs) byVendor.set(o.vendor_id, [...(byVendor.get(o.vendor_id) ?? []), o.data]);
  const contactFor = (vendorId: string) =>
    [...calls].reverse().find((c) => c.vendor_id === vendorId && c.contact_name)?.contact_name ?? undefined;

  const ranking = rank(
    items
      .filter((i) => byVendor.has(i.vendor_id))
      .map((i) => ({
        vendor_id: i.vendor_id,
        vendor_name: i.vendor.name,
        phone: i.vendor.phone_e164,
        contact_name: contactFor(i.vendor_id),
        offers: byVendor.get(i.vendor_id)!,
      })),
    need,
  );

  // Who might match the best price if we go back to them (user must approve round 2).
  const outbound = calls.filter((c) => c.direction === "outbound" && c.vendor_id);
  const order = items
    .filter((i) => outbound.some((c) => c.vendor_id === i.vendor_id))
    .map((i) => {
      const exact = (byVendor.get(i.vendor_id) ?? []).filter((o) => o.kind === "exact" && typeof o.total_price === "number");
      const lowest = exact.length ? Math.min(...exact.map((o) => o.total_price!)) : undefined;
      const heard = outbound.some((c) => c.vendor_id === i.vendor_id && c.leverage != null);
      return { vendor_id: i.vendor_id, vendor_name: i.vendor.name, total: lowest, heard_leverage: heard };
    });
  const best = ranking.best_overall ?? ranking.cheapest_valid;
  const round_two = roundTwoCandidates(order, best?.offer.total_price, best?.vendor_id);

  const flags = calls
    .map((c) => c.negotiation_check as { ok: boolean; issues: string[] } | null)
    .filter((c): c is { ok: boolean; issues: string[] } => !!c && !c.ok)
    .flatMap((c) => c.issues);

  return {
    run_id: runId,
    generated_at: ctx.now().toISOString(),
    request: run.request.text,
    ranking,
    vendors: items
      .filter((i) => i.selected)
      .map((i) => {
        const last = [...calls].reverse().find((c) => c.vendor_id === i.vendor_id);
        return { name: i.vendor.name, phone: i.vendor.phone_e164, status: i.status, summary: last?.summary ?? undefined, contact: contactFor(i.vendor_id) };
      }),
    unanswered_questions: checkpoints
      .filter((c) => c.status === "skipped")
      .map((c) => ({ vendor: items.find((i) => i.vendor_id === c.vendor_id)?.vendor.name ?? "?", question: c.question })),
    round_two,
    next_step: nextStep(best),
    negotiation_flags: flags,
  };
}

function nextStep(best: RankedOffer | null): string {
  if (!best) return "No vendor gave a comparable quote. Consider calling the vendors that didn't answer, or widening the search.";
  const o = best.offer;
  return (
    `Call ${best.vendor_name} on ${best.phone}` +
    (best.contact_name ? ` and ask for ${best.contact_name}` : "") +
    `. Mention their quote of $${o.total_price!.toFixed(0)}${o.phase === "negotiated" ? " (the negotiated price)" : ""}` +
    (o.valid_until ? `, valid until ${o.valid_until}` : "") +
    (o.earliest_date ? `. They can do it from ${o.earliest_date}` : "") +
    "."
  );
}

const money = (n?: number) => (typeof n === "number" ? `$${n.toFixed(0)}` : "n/a");

function line(r: RankedOffer): string {
  const o = r.offer;
  return `${r.vendor_name}: ${money(o.total_price)} for ${o.description}${o.earliest_date ? `, from ${o.earliest_date}` : ""}${r.notes.length ? ` (${r.notes.join(" ")})` : ""}`;
}

export function renderReportText(report: Report, links: { board: string }, updated = false): { subject: string; text: string } {
  const r = report.ranking;
  const best = r.best_overall ?? r.cheapest_valid;
  const subject =
    (updated ? "Updated report: " : "Ringer report: ") +
    (best ? `best ${money(best.offer.total_price)} at ${best.vendor_name}` : "no comparable quotes yet");
  const out: string[] = [];
  if (updated) out.push("A vendor got back to us after your report went out, so here's the updated picture.\n");
  out.push(`Your request: ${report.request}\n`);
  out.push("RECOMMENDED NEXT STEP");
  out.push(report.next_step + "\n");
  if (r.best_overall) out.push(`Best overall: ${line(r.best_overall)}`);
  if (r.cheapest_valid && r.cheapest_valid.vendor_id !== r.best_overall?.vendor_id) out.push(`Cheapest: ${line(r.cheapest_valid)}`);
  if (r.fastest && r.fastest.vendor_id !== r.best_overall?.vendor_id) out.push(`Fastest: ${line(r.fastest)}`);
  out.push("");
  out.push(...r.explanation);
  if (r.exact.length > 1) {
    out.push("\nAll exact matches:");
    for (const x of r.exact) out.push(`  - ${line(x)}`);
  }
  if (r.alternatives.length) {
    out.push("\nAlternatives offered (not exactly what you asked for):");
    for (const x of r.alternatives) out.push(`  - ${line(x)}`);
  }
  if (r.not_comparable.length) {
    out.push("\nIncomplete quotes:");
    for (const x of r.not_comparable) out.push(`  - ${line(x)}`);
  }
  out.push("\nEvery vendor:");
  for (const v of report.vendors) out.push(`  - ${v.name}: ${v.status.replace(/_/g, " ")}${v.summary ? `. ${v.summary}` : ""}`);
  if (report.unanswered_questions.length) {
    out.push("\nQuestions you didn't get to (we carried on without them):");
    for (const q of report.unanswered_questions) out.push(`  - ${q.vendor}: ${q.question}`);
  }
  if (report.round_two.length) {
    out.push("\nWorth a second call? These vendors were called before the best price came in:");
    for (const c of report.round_two)
      out.push(`  - ${c.vendor_name} quoted ${money(c.their_total)}. They might match ${money(c.best_total)}.`);
    out.push("  Tell ChatGPT \"call them back\" and approve, or leave it.");
  }
  if (report.negotiation_flags.length) {
    out.push("\nFlagged for review:");
    for (const f of report.negotiation_flags) out.push(`  - ${f}`);
  }
  out.push(`\nSee the board, with every call's transcript: ${links.board}`);
  out.push("Done with this request? Press Resolved on the board and we'll stop following it up.");
  return { subject, text: out.join("\n") };
}

export async function sendReport(ctx: Ctx, runId: string, opts: { updated: boolean }): Promise<Report> {
  const run = (await store.getRun(ctx.db, runId))!;
  const report = await buildReport(ctx, runId);
  const suppressed = run.resolved_at !== null;
  await store.setReport(ctx.db, runId, report, !suppressed);
  if (!suppressed) {
    const { subject, text } = renderReportText(report, { board: boardUrl(ctx, runId, run.user_id) }, opts.updated);
    await ctx.providers.mailer.send({ to: run.request.notify_email, subject, text });
    await store.audit(ctx.db, { run_id: runId, actor: "system", type: opts.updated ? "report.updated_sent" : "report.sent" });
  }
  return report;
}
