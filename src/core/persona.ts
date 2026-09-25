import type { Need } from "./types.js";

/**
 * The user's voice agent. Each user chooses the name and voice (a self-serve
 * onboarding flow for this is a later phase); "Maddie" is only the default.
 */
export interface Persona {
  assistant: string; // e.g. "Maddie"
  owner: string | null; // the user's first name, e.g. "Zealand"
  voiceId: string | null; // ElevenLabs voice id; null = the agent's default voice
}

export const DEFAULT_ASSISTANT_NAME = "Maddie";

export function personaOf(user: { assistant_name?: string | null; owner_name?: string | null; voice_id?: string | null }): Persona {
  return {
    assistant: user.assistant_name?.trim() || DEFAULT_ASSISTANT_NAME,
    owner: user.owner_name?.trim() || null,
    voiceId: user.voice_id?.trim() || null,
  };
}

/** "on behalf of Zealand", or "on behalf of a customer" when no name is set. */
export function onBehalfOf(p: Persona): string {
  return p.owner ?? "a customer";
}

/** "Zealand's virtual receptionist" / "a virtual receptionist". */
export function receptionistTitle(p: Persona): string {
  return p.owner ? `${p.owner}'s virtual receptionist` : "a virtual receptionist";
}

/** Short spoken description of what's being asked about, e.g. "4 x 205/55R16 91V tyres". */
export function describeNeed(need: Need): string {
  const spec = [need.specs.size, need.specs.load_speed_index].filter(Boolean).join(" ");
  return [need.quantity && need.quantity > 1 ? `${need.quantity} x` : null, spec || null, need.item].filter(Boolean).join(" ");
}

/** Rules every prompt carries, whatever the persona's wording. */
export function honestyRules(p: Persona): string {
  return `- You are an AI voice agent named ${p.assistant}. If anyone asks whether you're a real person, a robot or an AI, always say plainly that you're an AI assistant. Never claim or imply you're human.
- You may share ${p.owner ? `the first name "${p.owner}"` : "nothing about who you're calling for"}. Never share surnames, phone numbers (other than "this number"), addresses, or any other personal details.`;
}
