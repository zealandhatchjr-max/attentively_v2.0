import { z } from "zod";

/**
 * The only place in the codebase that reads process.env.
 * Every API key and secret comes from environment variables (see .env.example).
 */

const optional = z.string().optional().transform((v) => (v === "" ? undefined : v));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8787),
  ATTENTIVELY_BASE_URL: z.string().default("http://localhost:8787"),
  LINK_SIGNING_SECRET: optional,

  // Empty DATABASE_URL = embedded Postgres (PGlite) for local dev and tests.
  DATABASE_URL: optional,
  PGLITE_DATA_DIR: optional,

  // Provider switches: "fake" runs everything locally with simulated vendors.
  VOICE_PROVIDER: z.enum(["fake", "elevenlabs"]).default("fake"),
  PLACES_PROVIDER: z.enum(["fake", "google"]).default("fake"),
  EXTRACTOR_PROVIDER: z.enum(["fake", "anthropic"]).default("fake"),
  MAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  BOARD_PROVIDER: z.enum(["local", "kolaboreyt"]).default("local"),
  NUMBER_PROVIDER: z.enum(["fake", "twilio"]).default("fake"),

  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_AU_ADDRESS_SID: optional,
  TWILIO_AU_BUNDLE_SID: optional,

  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_AGENT_ID: optional,
  ELEVENLABS_WEBHOOK_SECRET: optional,

  ANTHROPIC_API_KEY: optional,
  EXTRACTOR_MODEL: z.string().default("claude-opus-5"),

  PLACES_API_KEY: optional,

  KOLABOREYT_API_KEY: optional,
  KOLABOREYT_BASE_URL: optional,

  EMAIL_PROVIDER_API_KEY: optional,
  EMAIL_FROM_ADDRESS: z.string().default("Attentively <reports@example.com>"),
  ASSISTANT_EMAIL_DOMAIN: z.string().default("assist.example.com"),
  INBOUND_EMAIL_WEBHOOK_SECRET: optional,

  // Product rules
  MAX_CALLS_PER_RUN: z.coerce.number().int().positive().default(12),
  EST_MINUTES_PER_CALL: z.coerce.number().positive().default(5),
  MIN_SECONDS_TO_DIAL: z.coerce.number().int().nonnegative().default(120),
  NEEDS_YOU_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(120),
  PILOT_MINUTES: z.coerce.number().int().nonnegative().default(600),
  DEFAULT_TIMEZONE: z.string().default("Australia/Brisbane"),
  COVERAGE_KEYWORDS: z
    .string()
    .default(
      "gold coast,southport,surfers paradise,broadbeach,robina,varsity lakes,burleigh,nerang,helensvale,coomera,palm beach,mudgeeraba,labrador,ashmore,bundall,miami,tugun,coolangatta,upper coomera,oxenford",
    ),
  // Google Places verification: re-check a vendor if its last check is older than this.
  VERIFY_MAX_AGE_DAYS: z.coerce.number().int().positive().default(14),
  PLACES_LOOKUPS_PER_USER_PER_DAY: z.coerce.number().int().positive().default(40),
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  CALL_POLL_SECONDS: z.coerce.number().int().positive().default(15),
});

export type Config = z.infer<typeof EnvSchema> & { coverage: string[]; linkSecret: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;

  const required: Array<[boolean, string[]]> = [
    [c.VOICE_PROVIDER === "elevenlabs", ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID"]],
    [c.NUMBER_PROVIDER === "twilio", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "ELEVENLABS_API_KEY"]],
    [c.PLACES_PROVIDER === "google", ["PLACES_API_KEY"]],
    [c.EXTRACTOR_PROVIDER === "anthropic", ["ANTHROPIC_API_KEY"]],
    [c.MAIL_PROVIDER === "resend", ["EMAIL_PROVIDER_API_KEY"]],
    [c.BOARD_PROVIDER === "kolaboreyt", ["KOLABOREYT_API_KEY", "KOLABOREYT_BASE_URL"]],
    [c.NODE_ENV === "production", ["LINK_SIGNING_SECRET", "DATABASE_URL"]],
  ];
  const missing = required
    .filter(([when]) => when)
    .flatMap(([, keys]) => keys)
    .filter((k) => !(c as Record<string, unknown>)[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${[...new Set(missing)].join(", ")}`);
  }

  return {
    ...c,
    coverage: c.COVERAGE_KEYWORDS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    linkSecret: c.LINK_SIGNING_SECRET ?? "dev-only-link-secret-change-me",
  };
}

/** Names of env vars whose values must never be logged. */
export const SECRET_ENV_NAMES = [
  "LINK_SIGNING_SECRET",
  "DATABASE_URL",
  "TWILIO_AUTH_TOKEN",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "PLACES_API_KEY",
  "KOLABOREYT_API_KEY",
  "EMAIL_PROVIDER_API_KEY",
  "INBOUND_EMAIL_WEBHOOK_SECRET",
];
