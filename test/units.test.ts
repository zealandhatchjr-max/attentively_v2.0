import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isOpen, nextOpening } from "../src/core/hours.js";
import { signLink, verifyLink } from "../src/core/links.js";
import { rank } from "../src/core/ranking.js";
import { buildCallPrompt, checkNegotiation } from "../src/orchestrator/script.js";
import { personaOf } from "../src/core/persona.js";
import { makeLogger } from "../src/server.js";

const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "17:00" }));
const TZ = "Australia/Brisbane";

describe("business hours", () => {
  it("is open mid-morning on a weekday and closed on Sunday", () => {
    expect(isOpen(weekdays, new Date("2026-09-23T00:00:00Z"), TZ)).toBe(true); // Wed 10:00
    expect(isOpen(weekdays, new Date("2026-09-27T00:00:00Z"), TZ)).toBe(false); // Sun 10:00
  });
  it("won't call in the last 20 minutes before close", () => {
    expect(isOpen(weekdays, new Date("2026-09-23T06:45:00Z"), TZ)).toBe(false); // Wed 16:45
  });
  it("treats unknown hours as closed", () => {
    expect(isOpen(null, new Date(), TZ)).toBe(false);
    expect(nextOpening([], new Date(), TZ)).toBeNull();
  });
  it("finds Monday 8am from Saturday night", () => {
    const next = nextOpening(weekdays, new Date("2026-09-26T11:00:00Z"), TZ); // Sat 21:00
    expect(next?.toISOString()).toBe("2026-09-27T22:00:00.000Z"); // Mon 08:00 AEST
  });
});

describe("signed links", () => {
  it("round-trips, and rejects tampering, the wrong purpose and expiry", () => {
    const t = signLink("s3cret", { run: "run_1", user: "usr_1", purpose: "board" }, 60);
    expect(verifyLink("s3cret", t, "board")?.run).toBe("run_1");
    expect(verifyLink("s3cret", t, "approve")).toBeNull();
    expect(verifyLink("other", t, "board")).toBeNull();
    expect(verifyLink("s3cret", t.replace(/^./, "x"), "board")).toBeNull();
    expect(verifyLink("s3cret", signLink("s3cret", { run: "r", user: "u", purpose: "board" }, -10), "board")).toBeNull();
  });
});

describe("ranking", () => {
  const need = { item: "tyres", quantity: 4, required_by: "2026-10-01", specs: {} };
  const v = (id: string, offers: any[]) => ({ vendor_id: id, vendor_name: id, phone: "+61", offers });

  it("never deducts conditional promos, and uses the negotiated price", () => {
    const r = rank(
      [
        v("A", [{ kind: "exact", phase: "initial", description: "x", total_price: 600, promo: "$100 gift card", promo_conditional: true, earliest_date: "2026-09-30" }]),
        v("B", [
          { kind: "exact", phase: "initial", description: "x", total_price: 660, earliest_date: "2026-09-30" },
          { kind: "exact", phase: "negotiated", description: "x", total_price: 590, earliest_date: "2026-09-30" },
        ]),
      ],
      need,
    );
    expect(r.best_overall?.vendor_id).toBe("B");
    expect(r.best_overall?.offer.total_price).toBe(590);
    expect(r.exact.find((x) => x.vendor_id === "A")?.offer.total_price).toBe(600);
  });

  it("keeps alternatives and incomplete quotes out of the main ranking", () => {
    const r = rank(
      [
        v("Alt", [{ kind: "alternative", phase: "initial", description: "other brand", total_price: 400 }]),
        v("Extras", [{ kind: "exact", phase: "initial", description: "x", total_price: 500, unknown_mandatory_extras: true }]),
        v("Ok", [{ kind: "exact", phase: "initial", description: "x", total_price: 650, earliest_date: "2026-09-29" }]),
      ],
      need,
    );
    expect(r.best_overall?.vendor_id).toBe("Ok");
    expect(r.alternatives.map((x) => x.vendor_id)).toEqual(["Alt"]);
    expect(r.not_comparable.map((x) => x.vendor_id)).toEqual(["Extras"]);
  });

  it("prefers a confirmed date over an unknown one, and flags a missed date", () => {
    const r = rank(
      [
        v("NoDate", [{ kind: "exact", phase: "written", description: "x", total_price: 580 }]),
        v("Late", [{ kind: "exact", phase: "initial", description: "x", total_price: 550, earliest_date: "2026-10-09" }]),
        v("OnTime", [{ kind: "exact", phase: "initial", description: "x", total_price: 610, earliest_date: "2026-09-28" }]),
      ],
      need,
    );
    expect(r.best_overall?.vendor_id).toBe("OnTime");
    expect(r.cheapest_valid?.vendor_id).toBe("Late");
  });
});

describe("negotiation audit", () => {
  const lev = { vendor_name: "Varsity Tyrepower", total: 620, observation_evidence: "" };
  const others = ["Varsity Tyrepower", "Robina Tyre & Auto"];

  it("passes when the approved quote is cited after the vendor's own price", () => {
    const res = checkNegotiation(
      [
        { role: "vendor", text: "It's $660 fitted." },
        { role: "agent", text: "Varsity Tyrepower quoted $620 for the same tyre. Can you do better?" },
      ],
      lev,
      others,
    );
    expect(res.ok).toBe(true);
  });

  it("flags citing a competitor before the vendor quotes, wrong figures, and unapproved vendors", () => {
    expect(checkNegotiation([{ role: "agent", text: "Varsity Tyrepower quoted $620." }], lev, others).issues[0]).toMatch(/before the vendor/);
    expect(
      checkNegotiation([{ role: "vendor", text: "$700" }, { role: "agent", text: "Varsity Tyrepower quoted $580." }], lev, others).ok,
    ).toBe(false);
    expect(
      checkNegotiation([{ role: "vendor", text: "$700" }, { role: "agent", text: "Robina Tyre & Auto quoted $620." }], lev, others).ok,
    ).toBe(false);
    expect(checkNegotiation([{ role: "vendor", text: "$700" }, { role: "agent", text: "Robina Tyre & Auto is cheaper" }], null, others).ok).toBe(false);
  });

  it("allows the agent to repeat the vendor's own price", () => {
    expect(checkNegotiation([{ role: "vendor", text: "$700" }, { role: "agent", text: "So $700 all up?" }], null, others).ok).toBe(true);
  });
});

describe("config and secrets", () => {
  it("fails fast when a real provider is selected without its key", () => {
    expect(() => loadConfig({ VOICE_PROVIDER: "elevenlabs" } as NodeJS.ProcessEnv)).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => loadConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/LINK_SIGNING_SECRET/);
  });

  it("redacts secret values from logs", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => lines.push(s);
    try {
      makeLogger({ ANTHROPIC_API_KEY: "sk-ant-supersecret" } as NodeJS.ProcessEnv)("oops", { err: "bad key sk-ant-supersecret" });
    } finally {
      console.log = orig;
    }
    expect(lines[0]).not.toContain("supersecret");
    expect(lines[0]).toContain("[redacted]");
  });
});

describe("voice agent persona", () => {
  const brief = {
    need: { item: "tyres", quantity: 4, specs: { size: "205/55R16", load_speed_index: "91V", fitted: true } },
    questions: [],
    resolved_answers: [],
    learned_facts: [],
    allow_negotiation: true,
  };
  const zealand = personaOf({ assistant_name: "Maddie", owner_name: "Zealand", voice_id: null });

  it("opens with the user's persona and owner name", () => {
    const { firstMessage } = buildCallPrompt({ category: "tyres", vendorName: "Robina Tyre & Auto", brief, leverage: null, persona: zealand, transcriptionNotice: false });
    expect(firstMessage).toBe(
      "Hi, I'm Maddie, a virtual receptionist calling on behalf of Zealand. I was wondering if you could help me with a quote for 4 x 205/55R16 91V tyres.",
    );
  });

  it("uses a different name the user chose, and a neutral default without an owner", () => {
    const { firstMessage } = buildCallPrompt({ category: "tyres", vendorName: "X", brief, leverage: null, persona: personaOf({ assistant_name: "Sam" }), transcriptionNotice: false });
    expect(firstMessage).toMatch(/^Hi, I'm Sam, a virtual receptionist calling on behalf of a customer\./);
  });

  it("adds the transcription notice only when switched on", () => {
    const on = buildCallPrompt({ category: "tyres", vendorName: "X", brief, leverage: null, persona: zealand, transcriptionNotice: true });
    expect(on.firstMessage).toContain("This call is transcribed.");
  });

  it("always admits being an AI and shares only the first name", () => {
    const { systemPrompt } = buildCallPrompt({ category: "tyres", vendorName: "X", brief, leverage: null, persona: zealand, transcriptionNotice: false });
    expect(systemPrompt).toMatch(/always say plainly that you're an AI assistant/);
    expect(systemPrompt).toMatch(/Never claim or imply you're human/);
    expect(systemPrompt).toMatch(/first name "Zealand"/);
    expect(systemPrompt).toMatch(/Never share surnames, phone numbers/);
  });

  it("uses the persona on call-backs", () => {
    const { firstMessage } = buildCallPrompt({ category: "tyres", vendorName: "X", brief, leverage: null, persona: zealand, transcriptionNotice: false, isCallback: true });
    expect(firstMessage).toBe("Hi, it's Maddie, Zealand's virtual receptionist, calling back about the 4 x 205/55R16 91V tyres enquiry from earlier.");
  });
});
