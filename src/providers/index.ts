import type { Config } from "../config.js";
import { AnthropicExtractor } from "./anthropic-extractor.js";
import { ElevenLabsVoice } from "./elevenlabs.js";
import { FakeExtractor, FakeNumbers, FakePlaces, FakeVoice, LocalBoard, MemoryMailer } from "./fake/index.js";
import { GooglePlaces } from "./google-places.js";
import { KolaboreytBoard } from "./kolaboreyt.js";
import { ResendMailer } from "./resend.js";
import { TwilioNumbers } from "./twilio.js";
import type { Providers } from "./types.js";

export function buildProviders(cfg: Config): Providers {
  return {
    voice: cfg.VOICE_PROVIDER === "elevenlabs" ? new ElevenLabsVoice(cfg.ELEVENLABS_API_KEY!, cfg.ELEVENLABS_AGENT_ID!) : new FakeVoice(),
    numbers:
      cfg.NUMBER_PROVIDER === "twilio"
        ? new TwilioNumbers(cfg.TWILIO_ACCOUNT_SID!, cfg.TWILIO_AUTH_TOKEN!, cfg.ELEVENLABS_API_KEY!, {
            bundleSid: cfg.TWILIO_AU_BUNDLE_SID,
            addressSid: cfg.TWILIO_AU_ADDRESS_SID,
            smsWebhookUrl: `${cfg.ATTENTIVELY_BASE_URL}/webhooks/sms`,
            label: (userId) => `attentively-${userId}`,
          })
        : new FakeNumbers(),
    places: cfg.PLACES_PROVIDER === "google" ? new GooglePlaces(cfg.PLACES_API_KEY!) : new FakePlaces(),
    extractor: cfg.EXTRACTOR_PROVIDER === "anthropic" ? new AnthropicExtractor(cfg.ANTHROPIC_API_KEY!, cfg.EXTRACTOR_MODEL) : new FakeExtractor(),
    mailer: cfg.MAIL_PROVIDER === "resend" ? new ResendMailer(cfg.EMAIL_PROVIDER_API_KEY!, cfg.EMAIL_FROM_ADDRESS) : new MemoryMailer(true),
    board:
      cfg.BOARD_PROVIDER === "kolaboreyt"
        ? new KolaboreytBoard(cfg.KOLABOREYT_API_KEY!, cfg.KOLABOREYT_BASE_URL!)
        : new LocalBoard((runId) => `${cfg.ATTENTIVELY_BASE_URL}/runs/${runId}`),
  };
}
