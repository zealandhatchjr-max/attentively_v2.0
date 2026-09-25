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
 * Local board: Attentively itself serves the board page (see http/pages.ts), so email
 * links work before Kolaboreyt is connected. Items are kept for inspection.
 */
export class LocalBoard implements BoardProvider {
  name = "local";
  items = new Map<string, Map<string, BoardItem>>();
  headers = new Map<string, Record<string, string>>();
  constructor(private shareUrl: (runId: string) => string) {}
  async createBoard(input: { runId: string; header: Record<string, string> }) {
    const boardId = `local-${input.runId}`;
    this.items.set(boardId, new Map());
    this.headers.set(boardId, input.header);
    return { boardId, shareUrl: this.shareUrl(input.runId) };
  }
  async upsertItem(boardId: string, item: BoardItem) {
    if (!this.items.has(boardId)) this.items.set(boardId, new Map());
    this.items.get(boardId)!.set(item.vendorId, item);
  }
  async updateHeader(boardId: string, header: Record<string, string>) {
    this.headers.set(boardId, { ...(this.headers.get(boardId) ?? {}), ...header });
  }
}
