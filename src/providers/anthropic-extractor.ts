import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Extraction, Offer } from "../core/types.js";
import type { ExtractInput, Extractor } from "./types.js";

const OfferSchema = z.object({
  kind: z.enum(["exact", "alternative"]),
  phase: z.enum(["initial", "negotiated", "written"]),
  description: z.string(),
  brand: z.string().optional(),
  unit_price: z.number().optional(),
  total_price: z.number().optional(),
  currency: z.string().optional(),
  includes: z.array(z.string()).optional(),
  unknown_mandatory_extras: z.boolean().optional(),
  in_stock: z.boolean().optional(),
  earliest_date: z.string().optional(),
  promo: z.string().optional(),
  promo_conditional: z.boolean().optional(),
  warranty: z.string().optional(),
  valid_until: z.string().optional(),
  evidence: z.string(),
});

const ExtractionSchema = z.object({
  outcome: z.enum(["answered", "declined", "no_answer", "voicemail", "wrong_number", "incomplete"]),
  do_not_call_requested: z.boolean(),
  contact_name: z.string().optional(),
  offers: z.array(OfferSchema),
  out_of_brief_questions: z.array(z.object({ question: z.string(), why_outside: z.string() })),
  learned_facts: z.array(z.string()),
  summary: z.string(),
  callback_expected: z.boolean().optional(),
});

const SYSTEM = `You turn a phone call between an AI assistant (calling for a customer) and a local business into structured data.

Rules:
- Only record what the business actually said. Every offer needs "evidence": the exact words from the transcript that support it.
- total_price is the total for the requested quantity including any extras the business said are mandatory. If a mandatory extra was mentioned but not priced, set unknown_mandatory_extras true.
- If the business offered something different from what was asked (another brand, size or model), record it as kind "alternative".
- If the business improved its price after hearing a competing quote, record the improved price as a separate offer with phase "negotiated"; keep the first price as phase "initial".
- Mark promo_conditional true when a promotion needs a claim, a redemption or other conditions; never subtract it from total_price.
- Dates are ISO (YYYY-MM-DD), relative to today's date given in the input.
- out_of_brief_questions: questions the business asked that the assistant could not answer from the brief and that the customer must answer.
- do_not_call_requested: true if the business asked not to be called again.`;

/**
 * Transcript → structured observations using Claude with structured outputs.
 * Server-side refusal fallbacks are enabled ("default" routing).
 */
export class AnthropicExtractor implements Extractor {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  private async parse<T extends z.ZodType>(schema: T, content: string): Promise<z.infer<T>> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: betaZodOutputFormat(schema) },
    });
    if (response.stop_reason === "refusal") throw new Error("Extraction was declined by the model");
    if (response.stop_reason === "max_tokens") throw new Error("Extraction output was truncated");
    if (!response.parsed_output) throw new Error("Extraction output did not match the schema");
    return response.parsed_output as z.infer<T>;
  }

  async extract(input: ExtractInput): Promise<Extraction> {
    const transcript = input.transcript.map((t) => `${t.role === "agent" ? "ASSISTANT" : "BUSINESS"}: ${t.text}`).join("\n");
    return this.parse(
      ExtractionSchema,
      JSON.stringify({
        today: new Date().toISOString().slice(0, 10),
        category: input.category,
        business: input.vendorName,
        customer_need: input.need,
        questions_in_brief: input.questions,
      }) + `\n\nTRANSCRIPT:\n${transcript}`,
    );
  }

  async extractMessage(input: { category: string; vendorName: string; need: unknown; body: string }): Promise<Offer[]> {
    const out = await this.parse(
      z.object({ offers: z.array(OfferSchema) }),
      JSON.stringify({ today: new Date().toISOString().slice(0, 10), category: input.category, business: input.vendorName, customer_need: input.need }) +
        `\n\nWRITTEN MESSAGE FROM THE BUSINESS (all offers are phase "written"):\n${input.body}`,
    );
    return out.offers;
  }
}
