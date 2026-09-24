import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Providers } from "../providers/types.js";
import { signLink } from "./links.js";

export interface Ctx {
  db: Db;
  cfg: Config;
  providers: Providers;
  now: () => Date;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export function boardUrl(ctx: Ctx, runId: string, userId: string): string {
  const token = signLink(ctx.cfg.linkSecret, { run: runId, user: userId, purpose: "board" }, 60 * 24 * 3600);
  return `${ctx.cfg.RINGER_BASE_URL}/b/${token}`;
}

export function approvalUrl(ctx: Ctx, runId: string, userId: string, planVersion: number): string {
  const token = signLink(ctx.cfg.linkSecret, { run: runId, user: userId, purpose: "approve", plan: planVersion }, 3 * 24 * 3600);
  return `${ctx.cfg.RINGER_BASE_URL}/approve/${token}`;
}
