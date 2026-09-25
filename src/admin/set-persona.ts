import { createCtx } from "../server.js";
import * as store from "../core/store.js";
import { flag } from "./args.js";

/** Change an existing user's voice agent until self-serve onboarding exists. */
async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => a.includes("@"));
  if (!email) throw new Error("Usage: npm run set-persona -- you@example.com [--owner Zealand] [--assistant Maddie] [--voice <id> | --default-voice]");
  const ctx = await createCtx();
  const user = await store.userByEmail(ctx.db, email);
  if (!user) throw new Error(`No user ${email}`);
  await store.setPersona(ctx.db, user.id, {
    owner_name: flag(args, "owner"),
    assistant_name: flag(args, "assistant"),
    voice_id: args.includes("--default-voice") ? null : flag(args, "voice"),
  });
  const u = (await store.getUser(ctx.db, user.id))!;
  console.log(`${u.email}: ${u.assistant_name}, on behalf of ${u.owner_name ?? "a customer"}, voice ${u.voice_id ?? "(agent default)"}.`);
  await ctx.db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
