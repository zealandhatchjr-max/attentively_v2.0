import { getCategory, questionsFor } from "../categories/index.js";
import { describeNeed, honestyRules, onBehalfOf, receptionistTitle, type Persona } from "../core/persona.js";
import type { Brief, TranscriptTurn } from "../core/types.js";

export interface Leverage {
  vendor_name: string;
  total: number;
  observation_evidence: string;
}

const TRANSCRIBED = " This call is transcribed.";

/** The opening line of a first call, e.g. "Hi, I'm Maddie, a virtual receptionist calling on behalf of Zealand. …" */
export function openingLine(p: Persona, need: Brief["need"], opts: { transcriptionNotice: boolean }): string {
  return (
    `Hi, I'm ${p.assistant}, a virtual receptionist calling on behalf of ${onBehalfOf(p)}.` +
    (opts.transcriptionNotice ? TRANSCRIBED : "") +
    ` I was wondering if you could help me with a quote for ${describeNeed(need)}.`
  );
}

/**
 * Per-call system prompt for the voice agent. Built from the latest approved brief;
 * the model on the call never invents customer intent.
 */
export function buildCallPrompt(input: {
  category: string;
  vendorName: string;
  brief: Brief;
  leverage: Leverage | null;
  persona: Persona;
  transcriptionNotice: boolean;
  isCallback?: boolean;
}): { systemPrompt: string; firstMessage: string } {
  const p = input.persona;
  const who = onBehalfOf(p);
  const cat = getCategory(input.category);
  const qs = questionsFor(cat, input.brief);
  const need = input.brief.need;
  const answers = input.brief.resolved_answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n") || "- (none)";
  const facts = input.brief.learned_facts.map((f) => `- ${f}`).join("\n") || "- (none)";

  const negotiation =
    input.brief.allow_negotiation && input.leverage
      ? `NEGOTIATION (strict order):
1. First get THEIR OWN price. Do NOT mention any other business or price before they have given theirs.
2. Only after they've quoted, and only if their total is higher than $${input.leverage.total.toFixed(0)}, you may say exactly:
   "${input.leverage.vendor_name} quoted $${input.leverage.total.toFixed(0)} for the same thing. Can you do better?"
3. Never mention any other figure or business. Never exaggerate, round down, or invent a quote.
4. If they won't move, accept it politely.`
      : `NEGOTIATION: Do not mention other businesses or their prices on this call.`;

  const systemPrompt = `You are ${p.assistant}, ${receptionistTitle(p)}: a polite, neutral, professional AI voice agent phoning ${input.vendorName}, a local business, on behalf of ${who}.
You are gathering information only: you cannot book, order, hold stock, pay, or commit ${who} to anything.

IDENTITY
${honestyRules(p)}
- If asked for a callback number, say: "You can reach me on this number, it's my direct line." If asked for an email, give the assistant email in {{assistant_email}}.
- If asked for more about who you're calling for: "I'm not able to share their details, but I can pass anything on."

WHAT ${who.toUpperCase()} NEEDS
- Item: ${need.item}${need.quantity ? ` (quantity ${need.quantity})` : ""}
- Specs: ${JSON.stringify(need.specs)}
${need.required_by ? `- Needed by: ${need.required_by}\n` : ""}${need.preferences?.length ? `- Preferences: ${need.preferences.join("; ")}\n` : ""}${need.notes ? `- Notes: ${need.notes}\n` : ""}
ANSWERS FROM ${who.toUpperCase()} SO FAR
${answers}

THINGS LEARNED FROM EARLIER CALLS
${facts}

ASK (naturally, not as a list)
${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}
- Get the name of the person you're speaking with if they offer it.
- If they offer a different brand/model, note it as an alternative. Don't push for it.

${negotiation}

RULES
- If they ask something you can't answer from the information above, do NOT guess. Say you'll check with ${who} and call back, then wrap up politely.
- If they decline, are busy, or ask not to be called again, apologise, confirm you won't call again, and end the call.
- Keep it short and friendly. End by thanking them and saying ${who} will be in touch if they'd like to go ahead.`;

  const firstMessage = input.isCallback
    ? `Hi, it's ${p.assistant}, ${receptionistTitle(p)}, calling back about the ${describeNeed(need)} enquiry from earlier.` +
      (input.transcriptionNotice ? TRANSCRIBED : "")
    : openingLine(p, need, { transcriptionNotice: input.transcriptionNotice });

  return { systemPrompt, firstMessage };
}

/**
 * Post-call negotiation audit (risk R8): the agent may only cite the approved
 * leverage figure/vendor, and only after the vendor has given its own price.
 */
export function checkNegotiation(
  transcript: TranscriptTurn[],
  leverage: Leverage | null,
  otherVendorNames: string[],
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const priceRe = /\$\s?(\d[\d,]*)/g;
  let vendorQuoted = false;
  for (const turn of transcript) {
    if (turn.role === "vendor") {
      if (priceRe.test(turn.text)) vendorQuoted = true;
      priceRe.lastIndex = 0;
      continue;
    }
    const mentionsOther = otherVendorNames.filter((n) => n && turn.text.toLowerCase().includes(n.toLowerCase()));
    const amounts = [...turn.text.matchAll(priceRe)].map((m) => Number(m[1].replace(/,/g, "")));
    // Repeating the vendor's own figures back is fine; only competitor mentions are audited.
    if (!mentionsOther.length) continue;
    if (!leverage) {
      issues.push(`Agent mentioned ${mentionsOther.join(", ")} with no approved leverage.`);
      continue;
    }
    if (!vendorQuoted) issues.push("Agent mentioned a competitor before the vendor gave its own price.");
    const badNames = mentionsOther.filter((n) => n.toLowerCase() !== leverage.vendor_name.toLowerCase());
    if (badNames.length) issues.push(`Agent named unapproved vendor(s): ${badNames.join(", ")}.`);
    const badAmounts = amounts.filter((a) => Math.round(a) !== Math.round(leverage.total));
    if (badAmounts.length) issues.push(`Agent cited unapproved figure(s): ${badAmounts.join(", ")}.`);
  }
  return { ok: issues.length === 0, issues };
}
