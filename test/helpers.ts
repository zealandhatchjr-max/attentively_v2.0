import { loadConfig } from "../src/config.js";
import type { Ctx } from "../src/core/context.js";
import { onboardUser } from "../src/core/onboarding.js";
import { openDb } from "../src/db/index.js";
import { findVendors, planRun } from "../src/orchestrator/planning.js";
import { FakeExtractor, FakeNumbers, FakePlaces, FakeVoice, LocalBoard, MemoryMailer } from "../src/providers/fake/index.js";

export const WED_10AM_BRISBANE = new Date("2026-09-23T00:00:00Z");

export async function makeCtx(env: Record<string, string> = {}) {
  const cfg = loadConfig({ NODE_ENV: "test", ...env } as NodeJS.ProcessEnv);
  const db = await openDb({});
  const mailer = new MemoryMailer(false);
  const clock = { now: WED_10AM_BRISBANE };
  const ctx: Ctx = {
    db,
    cfg,
    providers: {
      voice: new FakeVoice(0),
      numbers: new FakeNumbers(),
      places: new FakePlaces(),
      extractor: new FakeExtractor(),
      mailer,
      board: new LocalBoard((id) => `http://test/runs/${id}`),
    },
    now: () => clock.now,
    log: () => {},
  };
  return { ctx, db, mailer, clock };
}

export async function planTyreRun(ctx: Ctx, opts: { minutes?: number; only?: string[]; share?: boolean } = {}) {
  const { user } = await onboardUser(ctx, { email: `u${Math.random()}@example.com`, minutes: opts.minutes ?? 120, share_data_opt_in: opts.share });
  const location = { text: "Robina, Gold Coast QLD", confirmed: true };
  const found = await findVendors(ctx, user.id, { category: "tyres", search_query: "tyre shop", location });
  const plan = await planRun(ctx, user.id, {
    request_text: "4 tyres fitted",
    category: "tyres",
    location,
    need: { item: "tyres", quantity: 4, required_by: "2026-10-30", specs: { size: "205/55R16", load_speed_index: "91V", fitted: true } },
    vendors: found.vendors.map((v) => ({ vendor_id: v.vendor_id, selected: !opts.only || opts.only.includes(v.name) })),
  });
  return { user, plan, found };
}
