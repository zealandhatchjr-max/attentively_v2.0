import type { Brief, Need } from "../core/types.js";

/**
 * Category registry. Categories are config, not code: adding one means adding an
 * entry here, never touching the run model or orchestrator.
 */
export interface Category {
  id: string;
  label: string;
  keywords: string[];
  /** Need fields the plan must have before calling. */
  required_specs: Array<{ key: string; label: string; hint?: string }>;
  /** What we ask every vendor, before any run-specific questions. */
  standard_questions: (need: Need) => string[];
  /** Fields that make two offers comparable. */
  comparable_requires: string[];
  /** Prices older than this are "last seen" context only, never quotes or leverage. */
  stale_after_days: number;
  answer_fields: string[];
}

const tyres: Category = {
  id: "tyres",
  label: "Tyres",
  keywords: ["tyre", "tire", "tyres", "tires", "wheel alignment", "puncture", "sidewall"],
  required_specs: [
    { key: "size", label: "Tyre size", hint: "e.g. 205/55R16 from the sidewall" },
    { key: "load_speed_index", label: "Load/speed index", hint: "e.g. 91V" },
    { key: "fitted", label: "Supplied and fitted?", hint: "true if they need fitting" },
  ],
  standard_questions: (need) => {
    const qty = need.quantity ?? 4;
    const size = need.specs.size ?? "the requested size";
    const lsi = need.specs.load_speed_index ? ` ${need.specs.load_speed_index}` : "";
    return [
      `Do you have ${qty} x ${size}${lsi} in stock, and which brands/models?`,
      need.specs.fitted === false
        ? `What is the price for ${qty}, supplied only?`
        : `What is the total price for ${qty} fitted, including balancing, valves and disposal? Is wheel alignment extra?`,
      "When is the earliest they could be fitted?",
      "Are there any current promotions, and what are the conditions?",
      "What warranty or road-hazard cover comes with them?",
      "How long is this quote valid?",
    ];
  },
  comparable_requires: ["total_price"],
  stale_after_days: 14,
  answer_fields: [
    "brand",
    "unit_price",
    "total_price",
    "includes",
    "in_stock",
    "earliest_date",
    "promo",
    "warranty",
    "valid_until",
  ],
};

const generic: Category = {
  id: "generic",
  label: "Local product or service",
  keywords: [],
  required_specs: [{ key: "description", label: "Exact item or service", hint: "model, size, variant" }],
  standard_questions: (need) => {
    const qty = need.quantity && need.quantity > 1 ? `${need.quantity} x ` : "";
    return [
      `Do you have ${qty}${need.item} available, and which options?`,
      "What is the total price, including any mandatory extras (installation, delivery, fees)?",
      "When is the earliest I could get it?",
      "Are there any current promotions, and what are the conditions?",
      "What warranty comes with it?",
      "How long is this price valid?",
    ];
  },
  comparable_requires: ["total_price"],
  stale_after_days: 7,
  answer_fields: ["unit_price", "total_price", "in_stock", "earliest_date", "promo", "warranty", "valid_until"],
};

const REGISTRY: Record<string, Category> = { tyres, generic };

export function getCategory(id: string): Category {
  return REGISTRY[id] ?? generic;
}

export function listCategories(): Category[] {
  return Object.values(REGISTRY);
}

export function guessCategory(text: string): Category {
  const t = text.toLowerCase();
  return listCategories().find((c) => c.keywords.some((k) => t.includes(k))) ?? generic;
}

export function missingSpecs(category: Category, need: Partial<Need>): string[] {
  const specs = need.specs ?? {};
  return category.required_specs
    .filter((s) => specs[s.key] === undefined || specs[s.key] === "")
    .map((s) => s.label + (s.hint ? ` (${s.hint})` : ""));
}

/** Questions for this call: category standard questions, plan extras, and anything the user answered at a checkpoint. */
export function questionsFor(category: Category, brief: Brief): string[] {
  return [...category.standard_questions(brief.need), ...brief.questions];
}
