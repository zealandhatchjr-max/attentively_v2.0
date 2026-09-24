import type { Extraction, OpeningHours, TranscriptTurn } from "../../core/types.js";
import type { PlaceResult } from "../types.js";

/**
 * Simulated Gold Coast tyre shops for local development, tests and demos.
 * Each persona scripts how the shop answers a call, including a negotiation
 * response, a question outside the brief, a decline, and a no-answer.
 */

const weekdays: OpeningHours = [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "17:30" }));
const withSat: OpeningHours = [...weekdays, { day: 6, open: "08:00", close: "12:00" }];
export const ALWAYS_OPEN: OpeningHours = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "23:59" }));

export interface Persona {
  place: PlaceResult;
  behaviour: "quote" | "asks_question" | "declines_dnc" | "no_answer" | "alternative_only";
  price_each: number;
  brand: string;
  earliest_days: number;
  /** Lowest total they'll go to if a lower real competing quote is mentioned. */
  floor_total?: number;
  promo?: string;
  contact?: string;
}

export const PERSONAS: Persona[] = [
  {
    place: { name: "Robina Tyre & Auto", phone: "+61755550101", address: "12 Robina Town Centre Dr, Robina QLD", hours: withSat, placeId: "fake-1", rating: 4.6 },
    behaviour: "quote",
    price_each: 165,
    brand: "Michelin Primacy 4",
    earliest_days: 1,
    floor_total: 620,
    contact: "Dave",
  },
  {
    place: { name: "Varsity Tyrepower", phone: "+61755550102", address: "3 Varsity Pde, Varsity Lakes QLD", hours: withSat, placeId: "fake-2", rating: 4.4 },
    behaviour: "quote",
    price_each: 155,
    brand: "Michelin Primacy 4",
    earliest_days: 2,
    promo: "Buy 4 get a $50 gift card (claim online)",
    contact: "Mel",
  },
  {
    place: { name: "Burleigh Wheel Centre", phone: "+61755550103", address: "88 West Burleigh Rd, Burleigh Heads QLD", hours: weekdays, placeId: "fake-3", rating: 4.2 },
    behaviour: "asks_question",
    price_each: 150,
    brand: "Continental PremiumContact 6",
    earliest_days: 3,
    contact: "Sam",
  },
  {
    place: { name: "Nerang Discount Tyres", phone: "+61755550104", address: "5 Spencer Rd, Nerang QLD", hours: weekdays, placeId: "fake-4", rating: 3.9 },
    behaviour: "declines_dnc",
    price_each: 0,
    brand: "",
    earliest_days: 0,
  },
  {
    place: { name: "Southport Tyre Mart", phone: "+61755550105", address: "140 Ferry Rd, Southport QLD", hours: weekdays, placeId: "fake-5", rating: 4.0 },
    behaviour: "no_answer",
    price_each: 0,
    brand: "",
    earliest_days: 0,
  },
  {
    place: { name: "Mudgeeraba Tyres", phone: "+61755550106", address: "1 Railway St, Mudgeeraba QLD", hours: withSat, placeId: "fake-6", rating: 4.7 },
    behaviour: "alternative_only",
    price_each: 130,
    brand: "Hankook Ventus Prime 4",
    earliest_days: 1,
    contact: "Priya",
  },
];

export function personaByPhone(phone: string): Persona | undefined {
  return PERSONAS.find((p) => p.place.phone === phone);
}

const money = (n: number) => `$${n.toFixed(0)}`;
const isoIn = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

/** Build a transcript + ground-truth extraction for a simulated call. */
export function simulateConversation(
  persona: Persona,
  ctx: { qty: number; size: string; leverage: { vendor: string; total: number } | null; answers: string[] },
): { transcript: TranscriptTurn[]; extraction: Extraction; durationSec: number } {
  const t: TranscriptTurn[] = [];
  const agent = (text: string) => t.push({ role: "agent", text });
  const vendor = (text: string) => t.push({ role: "vendor", text });
  const name = persona.place.name;
  agent(`Hi, I'm an AI assistant calling on behalf of a customer. This call is transcribed. Is this ${name}?`);

  if (persona.behaviour === "declines_dnc") {
    vendor("We don't deal with robots. Take us off your list and don't call again.");
    agent("Understood, I'll make sure we don't call again. Sorry for the interruption, have a good day.");
    return {
      transcript: t,
      durationSec: 25,
      extraction: {
        outcome: "declined",
        do_not_call_requested: true,
        offers: [],
        out_of_brief_questions: [],
        learned_facts: [],
        summary: "Vendor declined to speak with an AI and asked not to be called again.",
      },
    };
  }

  vendor(`Yeah, ${persona.contact ?? "speaking"}. What can I do for you?`);
  agent(`I'm after ${ctx.qty} x ${ctx.size} tyres, supplied and fitted. Do you have those in stock, and what would the total be?`);

  if (persona.behaviour === "alternative_only") {
    const total = persona.price_each * ctx.qty;
    vendor(`No Michelin in that size, but I've got ${persona.brand} for ${money(persona.price_each)} each, ${money(total)} fitted and balanced.`);
    agent("When could they be fitted, and how long is that price good for?");
    vendor(`Tomorrow's fine. Price is good for a week. I'm ${persona.contact}.`);
    agent("Thanks, I'll pass that on. The customer will call back if they want to go ahead.");
    return {
      transcript: t,
      durationSec: 170,
      extraction: {
        outcome: "answered",
        do_not_call_requested: false,
        contact_name: persona.contact,
        offers: [
          {
            kind: "alternative",
            phase: "initial",
            description: `${persona.brand} ${ctx.size} x${ctx.qty}, fitted & balanced`,
            brand: persona.brand,
            unit_price: persona.price_each,
            total_price: total,
            currency: "AUD",
            includes: ["fitting", "balancing"],
            in_stock: true,
            earliest_date: isoIn(persona.earliest_days),
            valid_until: isoIn(7),
            evidence: `${persona.brand} for ${money(persona.price_each)} each, ${money(total)} fitted and balanced`,
          },
        ],
        out_of_brief_questions: [],
        learned_facts: [`Michelin not stocked in ${ctx.size} at ${name}`],
        summary: `No exact match; offered ${persona.brand} as an alternative.`,
      },
    };
  }

  if (persona.behaviour === "asks_question" && !ctx.answers.some((a) => /run.?flat/i.test(a))) {
    vendor("Before I price it: are they run-flats? Some of those cars come with run-flats and it changes everything.");
    agent("I don't have that detail. I'll check with the customer and call back. Thanks for your help.");
    return {
      transcript: t,
      durationSec: 95,
      extraction: {
        outcome: "incomplete",
        do_not_call_requested: false,
        contact_name: persona.contact,
        offers: [],
        out_of_brief_questions: [
          { question: "Are the current tyres run-flats?", why_outside: "Run-flat status wasn't in the brief and changes price and availability." },
        ],
        learned_facts: [],
        summary: "Vendor needs to know whether the tyres are run-flats before quoting.",
        callback_expected: true,
      },
    };
  }

  const total = persona.price_each * ctx.qty;
  vendor(
    `Got ${persona.brand} in stock. ${money(persona.price_each)} each, so ${money(total)} fitted, balanced, valves and disposal included. Alignment's extra.` +
      (persona.promo ? ` There's a promo too: ${persona.promo}.` : ""),
  );
  const offers: Extraction["offers"] = [
    {
      kind: "exact",
      phase: "initial",
      description: `${persona.brand} ${ctx.size} x${ctx.qty}, fitted`,
      brand: persona.brand,
      unit_price: persona.price_each,
      total_price: total,
      currency: "AUD",
      includes: ["fitting", "balancing", "valves", "disposal"],
      in_stock: true,
      earliest_date: isoIn(persona.earliest_days),
      promo: persona.promo,
      promo_conditional: Boolean(persona.promo),
      warranty: "Manufacturer warranty",
      valid_until: isoIn(7),
      evidence: `${money(persona.price_each)} each, so ${money(total)} fitted, balanced, valves and disposal included`,
    },
  ];

  if (ctx.leverage && ctx.leverage.total < total) {
    agent(`Thanks. ${ctx.leverage.vendor} quoted ${money(ctx.leverage.total)} fitted for the same tyre. Can you do better?`);
    if (persona.floor_total && persona.floor_total < total) {
      const matched = Math.max(persona.floor_total, ctx.leverage.total);
      vendor(`I can do ${money(matched)} all up if they book this week.`);
      offers.push({ ...offers[0], phase: "negotiated", total_price: matched, unit_price: matched / ctx.qty, evidence: `I can do ${money(matched)} all up if they book this week` });
    } else {
      vendor("That's as sharp as we go, sorry.");
    }
  }
  agent("When's the earliest they could be fitted, and how long is the price valid?");
  vendor(`Could do ${persona.earliest_days === 1 ? "tomorrow" : `in ${persona.earliest_days} days`}. Price is good for a week. Ask for ${persona.contact}.`);
  agent("Great, thanks. The customer will be in touch if they'd like to go ahead.");

  return {
    transcript: t,
    durationSec: 180 + (ctx.leverage ? 45 : 0),
    extraction: {
      outcome: "answered",
      do_not_call_requested: false,
      contact_name: persona.contact,
      offers,
      out_of_brief_questions: [],
      learned_facts: [],
      summary: `${persona.brand} in stock, ${money(offers[offers.length - 1].total_price!)} fitted.`,
    },
  };
}
