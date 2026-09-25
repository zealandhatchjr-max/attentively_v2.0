import { randomBytes } from "node:crypto";
import type { Ctx } from "./context.js";
import * as store from "./store.js";

/**
 * Creates a subscriber with their hidden assistant identity: a dedicated number
 * (voice + SMS) and an assistant email. The user is never shown either one.
 */
export async function onboardUser(
  ctx: Ctx,
  input: {
    email: string;
    display_name?: string;
    minutes?: number;
    share_data_opt_in?: boolean;
    /** Voice agent persona. Chosen by the user in a later-phase onboarding flow; set by CLI for now. */
    assistant_name?: string;
    owner_name?: string;
    voice_id?: string;
  },
) {
  const { user, apiToken } = await store.createUser(ctx.db, {
    email: input.email,
    display_name: input.display_name,
    minutes_seconds: (input.minutes ?? ctx.cfg.PILOT_MINUTES) * 60,
    share_data_opt_in: input.share_data_opt_in,
  });
  const { number, voicePhoneNumberId } = await ctx.providers.numbers.provisionAssistantNumber(user.id);
  const assistantEmail = `a-${randomBytes(4).toString("hex")}@${ctx.cfg.ASSISTANT_EMAIL_DOMAIN}`;
  await store.setAssistantIdentity(ctx.db, user.id, { number, voice_phone_number_id: voicePhoneNumberId, email: assistantEmail });
  await store.setPersona(ctx.db, user.id, { assistant_name: input.assistant_name, owner_name: input.owner_name, voice_id: input.voice_id });
  await store.audit(ctx.db, { user_id: user.id, actor: "system", type: "user.onboarded" });
  return { user: (await store.getUser(ctx.db, user.id))!, apiToken };
}
