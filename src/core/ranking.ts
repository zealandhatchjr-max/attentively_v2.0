import type { Need, Offer } from "./types.js";

export interface RankedOffer {
  vendor_id: string;
  vendor_name: string;
  phone: string;
  contact_name?: string;
  offer: Offer;
  comparable: boolean;
  meets_date: boolean | null;
  notes: string[];
}

export interface Ranking {
  best_overall: RankedOffer | null;
  cheapest_valid: RankedOffer | null;
  fastest: RankedOffer | null;
  exact: RankedOffer[];
  alternatives: RankedOffer[];
  not_comparable: RankedOffer[];
  explanation: string[];
}

export interface OfferInput {
  vendor_id: string;
  vendor_name: string;
  phone: string;
  contact_name?: string;
  offers: Offer[];
}

/**
 * Deterministic ranking. The model never does price arithmetic:
 *  - A vendor's best offer is its negotiated/written price if lower than its initial one.
 *  - Conditional promos (gift cards, rebates) are never subtracted from the cash price.
 *  - Unknown mandatory extras mean "not fully comparable".
 */
export function rank(inputs: OfferInput[], need: Need): Ranking {
  const today = new Date().toISOString().slice(0, 10);
  const exact: RankedOffer[] = [];
  const alternatives: RankedOffer[] = [];
  const notComparable: RankedOffer[] = [];

  for (const v of inputs) {
    for (const kind of ["exact", "alternative"] as const) {
      const ofKind = v.offers.filter((o) => o.kind === kind);
      if (!ofKind.length) continue;
      const priced = ofKind.filter((o) => typeof o.total_price === "number");
      const best = priced.length ? priced.reduce((a, b) => (b.total_price! < a.total_price! ? b : a)) : ofKind[0];
      const notes: string[] = [];
      const comparable = typeof best.total_price === "number" && !best.unknown_mandatory_extras;
      if (best.unknown_mandatory_extras) notes.push("Has mandatory extras that weren't priced.");
      if (typeof best.total_price !== "number") notes.push("No total price given.");
      if (best.promo) notes.push(`Promo: ${best.promo}${best.promo_conditional ? " (conditional, not deducted)" : ""}.`);
      if (best.valid_until && best.valid_until < today) notes.push("Quote has expired.");
      if (best.phase === "negotiated") {
        const initial = ofKind.find((o) => o.phase === "initial");
        if (initial?.total_price) notes.push(`Negotiated down from $${initial.total_price.toFixed(0)}.`);
      }
      const meets_date =
        need.required_by && best.earliest_date ? best.earliest_date <= need.required_by : need.required_by ? null : true;
      const r: RankedOffer = {
        vendor_id: v.vendor_id,
        vendor_name: v.vendor_name,
        phone: v.phone,
        contact_name: v.contact_name,
        offer: best,
        comparable,
        meets_date,
        notes,
      };
      if (!comparable) notComparable.push(r);
      else (kind === "exact" ? exact : alternatives).push(r);
    }
  }

  const byPrice = (a: RankedOffer, b: RankedOffer) =>
    a.offer.total_price! - b.offer.total_price! || (a.offer.earliest_date ?? "9").localeCompare(b.offer.earliest_date ?? "9");
  exact.sort(byPrice);
  alternatives.sort(byPrice);

  const withinBudget = (r: RankedOffer) => !need.budget_max || r.offer.total_price! <= need.budget_max;
  const cheapest = exact.find(withinBudget) ?? null;
  const onTime = exact.filter((r) => r.meets_date !== false && withinBudget(r));
  // Prefer offers confirmed to meet the date over ones where the date is unknown.
  const best = onTime.find((r) => r.meets_date === true) ?? onTime[0] ?? null;
  const fastest =
    [...exact]
      .filter((r) => r.offer.earliest_date)
      .sort((a, b) => a.offer.earliest_date!.localeCompare(b.offer.earliest_date!) || byPrice(a, b))[0] ?? null;

  const explanation: string[] = [];
  if (best) {
    explanation.push(
      `Best overall: ${best.vendor_name}, the lowest total ($${best.offer.total_price!.toFixed(0)}) for an exact match` +
        (need.required_by
          ? best.meets_date
            ? ` that can be done by ${need.required_by}.`
            : `. They haven't confirmed they can do it by ${need.required_by}, so check when you call.`
          : "."),
    );
  } else if (exact.length) {
    explanation.push("No exact match meets every hard constraint (date or budget). See the options below.");
  } else {
    explanation.push("No vendor quoted an exact match.");
  }
  if (cheapest && best && cheapest.vendor_id !== best.vendor_id)
    explanation.push(`Cheapest valid: ${cheapest.vendor_name} at $${cheapest.offer.total_price!.toFixed(0)}, but it misses the required date.`);
  if (fastest && best && fastest.vendor_id !== best.vendor_id)
    explanation.push(`Fastest: ${fastest.vendor_name}, available ${fastest.offer.earliest_date}.`);
  if (alternatives.length)
    explanation.push(`${alternatives.length} alternative option(s) were offered. They're ranked separately because they aren't what you asked for.`);
  explanation.push("Conditional promotions are listed but never deducted from the price.");

  return { best_overall: best, cheapest_valid: cheapest, fastest, exact, alternatives, not_comparable: notComparable, explanation };
}

/** Round-2 suggestion: vendors called before a better quote existed, who might match it. */
export function roundTwoCandidates(
  callOrder: Array<{ vendor_id: string; vendor_name: string; total?: number; heard_leverage: boolean }>,
  bestTotal: number | undefined,
  bestVendorId: string | undefined,
): Array<{ vendor_id: string; vendor_name: string; their_total: number; best_total: number }> {
  if (bestTotal === undefined) return [];
  return callOrder
    .filter((c) => c.vendor_id !== bestVendorId && !c.heard_leverage && c.total !== undefined && c.total > bestTotal)
    .map((c) => ({ vendor_id: c.vendor_id, vendor_name: c.vendor_name, their_total: c.total!, best_total: bestTotal }));
}
