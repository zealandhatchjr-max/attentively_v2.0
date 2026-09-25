import type { Extraction, OpeningHours, Offer, TranscriptTurn } from "../core/types.js";

/**
 * Internal provider interfaces. Swapping a provider never changes the external
 * Attentively tool contract.
 */

export interface OutboundCallRequest {
  /** Idempotency key: our call id. */
  callId: string;
  to: string;
  fromPhoneNumberId: string | null;
  systemPrompt: string;
  firstMessage: string;
  /** Voice chosen by the user; null = the agent's default voice. */
  voiceId?: string | null;
  metadata: Record<string, string>;
}

export type ProviderCallStatus = "queued" | "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed";

export interface ProviderCallState {
  status: ProviderCallStatus;
  durationSec?: number;
  transcript?: TranscriptTurn[];
  failureReason?: string;
}

export interface VoiceProvider {
  name: string;
  startOutboundCall(req: OutboundCallRequest): Promise<{ providerCallId: string }>;
  getCall(providerCallId: string): Promise<ProviderCallState>;
}

export interface NumberProvider {
  /** Buys a local number and connects it to the voice agent for inbound calls. */
  provisionAssistantNumber(userId: string): Promise<{ number: string; voicePhoneNumberId: string }>;
}

export type BusinessStatus = "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY";

export interface PlaceResult {
  name: string;
  businessStatus?: BusinessStatus;
  phone: string;
  address?: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  hours?: OpeningHours;
  types?: string[];
  rating?: number;
}

/**
 * Verification only. Attentively never searches for vendors itself: the user's own
 * assistant (ChatGPT, Claude, ...) finds them under the user's subscription, and
 * Attentively checks them here only after the user has agreed to use Attentively.
 */
export interface PlacesProvider {
  /** Best match for a business the assistant found, e.g. "Robina Tyre & Auto, Robina QLD". */
  findPlace(query: string): Promise<PlaceResult | null>;
  lookupPhone(phone: string): Promise<PlaceResult | null>;
}

export interface ExtractInput {
  category: string;
  vendorName: string;
  need: unknown;
  questions: string[];
  transcript: TranscriptTurn[];
  providerCallId?: string;
}

export interface Extractor {
  extract(input: ExtractInput): Promise<Extraction>;
  /** Parse a written reply (SMS/email) from a vendor into offers. */
  extractMessage(input: { category: string; vendorName: string; need: unknown; body: string }): Promise<Offer[]>;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface BoardItem {
  vendorId: string;
  name: string;
  phone: string;
  status: string;
  columns: Record<string, string | number | boolean | null>;
}

/** Run-level fields shown on the board (Kolaboreyt: the run item's columns). */
export interface RunHeader {
  title: string;
  status: string; // run status, e.g. "running", "completed", "resolved"
  location: string;
  best_price: number | null;
  best_vendor: string | null;
  report_url: string;
}

/**
 * Where quote runs are documented. Attentively's database stays the system of
 * record; a board is a projection of it. Every method must be safe to repeat.
 */
export interface BoardProvider {
  name: string;
  /** Create (or find) the run's record. The returned ref is stored in runs.board_id. */
  createRun(runId: string, header: RunHeader): Promise<{ ref: string }>;
  updateRun(ref: string, runId: string, header: RunHeader): Promise<void>;
  upsertVendor(ref: string, runId: string, item: BoardItem): Promise<void>;
  /** Post a call's summary and transcript once per call. */
  postCallNote(ref: string, runId: string, vendorId: string, callId: string, text: string): Promise<void>;
  /** True if someone marked the run Resolved on the board itself. */
  isResolved(ref: string): Promise<boolean>;
}

export interface Providers {
  voice: VoiceProvider;
  numbers: NumberProvider;
  places: PlacesProvider;
  extractor: Extractor;
  mailer: Mailer;
  board: BoardProvider;
}
