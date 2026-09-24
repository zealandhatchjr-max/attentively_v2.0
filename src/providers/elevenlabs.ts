import type { TranscriptTurn } from "../core/types.js";
import type { OutboundCallRequest, ProviderCallState, VoiceProvider } from "./types.js";

/**
 * ElevenLabs Conversational AI over Twilio, used for outbound vendor calls.
 *
 * PHASE 0 VERIFY: endpoint shapes are written from ElevenLabs' public docs and
 * have not yet been run against a live account. The agent must allow
 * "prompt" and "first_message" overrides in its security settings, and audio
 * retention must be switched OFF (transcripts only, per product decision).
 */
export class ElevenLabsVoice implements VoiceProvider {
  name = "elevenlabs";
  private base = "https://api.elevenlabs.io/v1/convai";

  constructor(
    private apiKey: string,
    private agentId: string,
  ) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`ElevenLabs ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async startOutboundCall(req: OutboundCallRequest) {
    if (!req.fromPhoneNumberId) throw new Error("User has no assistant number configured");
    const out = await this.req<{ conversation_id?: string; callSid?: string; success?: boolean; message?: string }>(
      "/twilio/outbound-call",
      {
        method: "POST",
        body: JSON.stringify({
          agent_id: this.agentId,
          agent_phone_number_id: req.fromPhoneNumberId,
          to_number: req.to,
          conversation_initiation_client_data: {
            conversation_config_override: {
              agent: { prompt: { prompt: req.systemPrompt }, first_message: req.firstMessage, language: "en" },
            },
            dynamic_variables: req.metadata,
          },
        }),
      },
    );
    if (!out.conversation_id) throw new Error(`ElevenLabs did not start the call: ${out.message ?? "unknown"}`);
    return { providerCallId: out.conversation_id };
  }

  async getCall(providerCallId: string): Promise<ProviderCallState> {
    const c = await this.req<{
      status: "initiated" | "in-progress" | "processing" | "done" | "failed";
      transcript?: Array<{ role: "agent" | "user"; message: string | null; time_in_call_secs?: number }>;
      metadata?: { call_duration_secs?: number; termination_reason?: string };
    }>(`/conversations/${encodeURIComponent(providerCallId)}`);
    const transcript: TranscriptTurn[] = (c.transcript ?? [])
      .filter((t) => t.message)
      .map((t) => ({ role: t.role === "agent" ? "agent" : "vendor", text: t.message!, t: t.time_in_call_secs }));
    const durationSec = c.metadata?.call_duration_secs;
    switch (c.status) {
      case "initiated":
        return { status: "ringing" };
      case "in-progress":
      case "processing":
        return { status: "in_progress" };
      case "done":
        return transcript.some((t) => t.role === "vendor")
          ? { status: "completed", durationSec, transcript }
          : { status: "no_answer", durationSec, transcript };
      default:
        return { status: "failed", durationSec, failureReason: c.metadata?.termination_reason ?? "failed" };
    }
  }
}

/** Shape of the post-call webhook ElevenLabs sends (normalised). PHASE 0 VERIFY. */
export function parseElevenLabsPostCall(body: any): {
  providerCallId: string;
  agentNumber?: string;
  callerNumber?: string;
  direction: "inbound" | "outbound";
  durationSec?: number;
  transcript: TranscriptTurn[];
} | null {
  const d = body?.data;
  if (!d?.conversation_id) return null;
  const phone = d.metadata?.phone_call ?? {};
  return {
    providerCallId: d.conversation_id,
    agentNumber: phone.agent_number,
    callerNumber: phone.external_number,
    direction: phone.direction === "outbound" ? "outbound" : "inbound",
    durationSec: d.metadata?.call_duration_secs,
    transcript: (d.transcript ?? [])
      .filter((t: any) => t.message)
      .map((t: any) => ({ role: t.role === "agent" ? "agent" : "vendor", text: t.message, t: t.time_in_call_secs })),
  };
}
