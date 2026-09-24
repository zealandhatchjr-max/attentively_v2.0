import type { Extraction, OpeningHours, Offer, TranscriptTurn } from "../core/types.js";

/**
 * Internal provider interfaces. Swapping a provider never changes the external
 * Ringer tool contract.
 */

export interface OutboundCallRequest {
  /** Idempotency key: our call id. */
  callId: string;
  to: string;
  fromPhoneNumberId: string | null;
  systemPrompt: string;
  firstMessage: string;
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
 * Verification only. Ringer never searches for vendors itself: the user's own
 * assistant (ChatGPT, Claude, ...) finds them under the user's subscription, and
 * Ringer checks them here only after the user has agreed to use Ringer.
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

export interface BoardProvider {
  name: string;
  createBoard(input: { runId: string; title: string; header: Record<string, string>; columns: string[] }): Promise<{
    boardId: string;
    shareUrl: string;
  }>;
  upsertItem(boardId: string, item: BoardItem): Promise<void>;
  updateHeader(boardId: string, header: Record<string, string>): Promise<void>;
}

export interface Providers {
  voice: VoiceProvider;
  numbers: NumberProvider;
  places: PlacesProvider;
  extractor: Extractor;
  mailer: Mailer;
  board: BoardProvider;
}
