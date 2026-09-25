import type { Extraction, Offer } from "../../core/types.js";
import type {
  BoardItem,
  BoardProvider,
  Extractor,
  Mail,
  Mailer,
  NumberProvider,
  OutboundCallRequest,
  PlaceResult,
  PlacesProvider,
  ProviderCallState,
  RunHeader,
  VoiceProvider,
} from "../types.js";
import { PERSONAS, personaByPhone, simulateConversation } from "./vendors.js";

/** Shared between the fake voice provider and the fake extractor. */
const simulatedExtractions = new Map<string, Extraction>();

export class FakeVoice implements VoiceProvider {
  name = "fake";
  private calls = new Map<string, { state: ProviderCallState; polls: number }>();
  /** Number of polls a call stays "in_progress" before completing. */
  constructor(private pollsUntilDone = 1) {}

  async startOutboundCall(req: OutboundCallRequest) {
    const providerCallId = `fake-${req.callId}`;
    const persona = personaByPhone(req.to);
    if (!persona) {
      this.calls.set(providerCallId, { state: { status: "failed", failureReason: "unknown number" }, polls: 0 });
      return { providerCallId };
    }
    if (persona.behaviour === "no_answer") {
      this.calls.set(providerCallId, { state: { status: "no_answer", durationSec: 30 }, polls: 0 });
      return { providerCallId };
    }
    const leverage =
      req.metadata.leverage_vendor && req.metadata.leverage_total
        ? { vendor: req.metadata.leverage_vendor, total: Number(req.metadata.leverage_total) }
        : null;
    const sim = simulateConversation(persona, {
      qty: Number(req.metadata.need_qty || 4),
      size: req.metadata.need_spec || "205/55R16 91V",
      leverage,
      answers: JSON.parse(req.metadata.answers || "[]"),
      firstMessage: req.firstMessage,
    });
    simulatedExtractions.set(providerCallId, sim.extraction);
    this.calls.set(providerCallId, {
      state: { status: "completed", durationSec: sim.durationSec, transcript: sim.transcript },
      polls: 0,
    });
    return { providerCallId };
  }

  async getCall(providerCallId: string): Promise<ProviderCallState> {
    const c = this.calls.get(providerCallId);
    if (!c) return { status: "failed", failureReason: "unknown call" };
    c.polls += 1;
    if (c.polls <= this.pollsUntilDone && c.state.status === "completed") return { status: "in_progress" };
    return c.state;
  }
}

export class FakeExtractor implements Extractor {
  async extract(input: { providerCallId?: string }): Promise<Extraction> {
    const e = input.providerCallId ? simulatedExtractions.get(input.providerCallId) : undefined;
    return (
      e ?? {
        outcome: "incomplete",
        do_not_call_requested: false,
        offers: [],
        out_of_brief_questions: [],
        learned_facts: [],
        summary: "No simulated extraction available.",
      }
    );
  }

  async extractMessage(input: { body: string }): Promise<Offer[]> {
    // Minimal parser for simulated written quotes: "$590 fitted" style.
    const m = input.body.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
    if (!m) return [];
    const total = Number(m[1].replace(/,/g, ""));
    return [
      {
        kind: "exact",
        phase: "written",
        description: input.body.slice(0, 120),
        total_price: total,
        currency: "AUD",
        evidence: input.body.slice(0, 200),
      },
    ];
  }
}

export class FakePlaces implements PlacesProvider {
  lookups = 0;
  async findPlace(query: string): Promise<PlaceResult | null> {
    this.lookups += 1;
    const q = query.toLowerCase();
    return PERSONAS.find((p) => q.includes(p.place.name.toLowerCase()))?.place ?? null;
  }
  async lookupPhone(phone: string): Promise<PlaceResult | null> {
    this.lookups += 1;
    return personaByPhone(phone)?.place ?? null;
  }
}

export class FakeNumbers implements NumberProvider {
  private n = 0;
  async provisionAssistantNumber() {
    this.n += 1;
    return { number: `+6175559${String(1000 + this.n).slice(-4)}`, voicePhoneNumberId: `fake-pn-${this.n}` };
  }
}

export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  constructor(private log = false) {}
  async send(mail: Mail) {
    this.sent.push(mail);
    if (this.log) console.log(`\n📧 To: ${mail.to}\n   Subject: ${mail.subject}\n${mail.text.replace(/^/gm, "   ")}\n`);
  }
}

/**
 * Local board: Attentively itself serves the board page (see http/pages.ts), so
 * everything works without Kolaboreyt. Items are kept in memory for inspection.
 */
export class LocalBoard implements BoardProvider {
  name = "local";
  items = new Map<string, Map<string, BoardItem>>();
  headers = new Map<string, RunHeader>();
  notes = new Map<string, string>();
  async createRun(runId: string, header: RunHeader) {
    const ref = `local-${runId}`;
    this.items.set(ref, new Map());
    this.headers.set(ref, header);
    return { ref };
  }
  async updateRun(ref: string, _runId: string, header: RunHeader) {
    this.headers.set(ref, header);
  }
  async upsertVendor(ref: string, _runId: string, item: BoardItem) {
    if (!this.items.has(ref)) this.items.set(ref, new Map());
    this.items.get(ref)!.set(item.vendorId, item);
  }
  async postCallNote(_ref: string, _runId: string, _vendorId: string, callId: string, text: string) {
    if (!this.notes.has(callId)) this.notes.set(callId, text);
  }
  async isResolved() {
    return false; // the local board's Resolved button calls resolveRun directly
  }
}
