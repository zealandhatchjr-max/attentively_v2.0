import { createCtx } from "../server.js";
import { onboardUser } from "../core/onboarding.js";
import { flag } from "./args.js";

const USAGE =
  "Usage: npm run create-user -- you@example.com [--owner Zealand] [--assistant Maddie] [--voice <elevenlabs-voice-id>] [--share-data] [--minutes N]";

async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => a.includes("@"));
  if (!email) throw new Error(USAGE);
  const minutes = flag(args, "minutes");
  const ctx = await createCtx();
  const { user, apiToken } = await onboardUser(ctx, {
    email,
    share_data_opt_in: args.includes("--share-data"),
    minutes: minutes ? Number(minutes) : undefined,
    owner_name: flag(args, "owner"),
    assistant_name: flag(args, "assistant"),
    voice_id: flag(args, "voice"),
  });
  console.log(`Created ${user.email} (${user.id}) with ${Math.floor(user.minutes_balance_seconds / 60)} minutes.`);
  console.log(`Voice agent: ${user.assistant_name}${user.owner_name ? `, calling on behalf of ${user.owner_name}` : ""}${user.voice_id ? ` (voice ${user.voice_id})` : ""}.`);
  console.log(`MCP bearer token (shown once, store it securely): ${apiToken}`);
  await ctx.db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
