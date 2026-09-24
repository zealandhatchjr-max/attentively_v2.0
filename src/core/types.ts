import { randomBytes } from "node:crypto";

export const RunStatus = {
  AwaitingApproval: "awaiting_approval",
  Running: "running",
  NeedsUser: "needs_user",
  PausedMinutes: "paused_minutes",
  Completed: "completed",
  Resolved: "resolved",
  Stopped: "stopped",
  Failed: "failed",
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** Runs the worker should look at. */
export const ACTIVE_RUN_STATUSES: RunStatus[] = [RunStatus.Running, RunStatus.NeedsUser];

export const VendorItemStatus = {
  Queued: "queued",
  Calling: "calling",
  Processing: "processing",
  Done: "done",
  NeedsYou: "needs_you",
  NoAnswer: "no_answer",
  Declined: "declined",
  Failed: "failed",
  Skipped: "skipped",
  NotSelected: "not_selected",
} as const;
export type VendorItemStatus = (typeof VendorItemStatus)[keyof typeof VendorItemStatus];

export type OpeningHours = Array<{ day: number; open: string; close: string }>;

export interface Location {
  text: string;
  confirmed: boolean;
  lat?: number;
  lng?: number;
  timezone?: string;
}

export interface Need {
  item: string;
  quantity?: number;
  required_by?: string; // ISO date
  specs: Record<string, string | number | boolean>;
  preferences?: string[];
  budget_max?: number;
  notes?: string;
}

export interface Brief {
  need: Need;
  questions: string[];
  resolved_answers: Array<{ question: string; answer: string; from_checkpoint?: string }>;
  learned_facts: string[];
  allow_negotiation: boolean;
}

export interface PlanVendor {
  vendor_id: string;
  name: string;
  phone: string;
  recommended: boolean;
  reason?: string;
  source: "ringer" | "user_added";
  selected: boolean;
}

export interface Plan {
  version: number;
  round: number;
  category: string;
  location: Location;
  need: Need;
  questions: string[];
  vendors: PlanVendor[];
  calls_to_place: number;
  allow_negotiation: boolean;
  estimated_minutes: number;
  notify_email: string;
  disclosure: string;
}

/** One quoted option from a vendor, normalised across categories. */
export interface Offer {
  kind: "exact" | "alternative";
  phase: "initial" | "negotiated" | "written";
  description: string;
  brand?: string;
  unit_price?: number;
  total_price?: number; // effective total for the requested quantity, incl. known mandatory extras
  currency?: string;
  includes?: string[];
  unknown_mandatory_extras?: boolean;
  in_stock?: boolean;
  earliest_date?: string; // ISO date the item/service can be delivered/fitted
  promo?: string;
  promo_conditional?: boolean;
  warranty?: string;
  valid_until?: string;
  evidence?: string;
  fields?: Record<string, unknown>;
}

export interface Extraction {
  outcome: "answered" | "declined" | "no_answer" | "voicemail" | "wrong_number" | "incomplete";
  do_not_call_requested: boolean;
  contact_name?: string;
  offers: Offer[];
  out_of_brief_questions: Array<{ question: string; why_outside: string }>;
  learned_facts: string[];
  summary: string;
  callback_expected?: boolean;
}

export interface TranscriptTurn {
  role: "agent" | "vendor";
  text: string;
  t?: number;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("base64url")}`;
}

export class RingerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
