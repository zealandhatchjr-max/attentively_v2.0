import { createCtx } from "../server.js";
import { onboardUser } from "../core/onboarding.js";

/** Usage: npm run create-user -- you@example.com [--share-data] [--minutes 600] */
async function main() {
  const args = process.argv.slice(2);
  const email = args.find((a) => a.includes("@"));
  if (!email) throw new Error("Usage: npm run create-user -- you@example.com [--share-data] [--minutes N]");
  const mi = args.indexOf("--minutes");
  const ctx = await createCtx();
  const { user, apiToken } = await onboardUser(ctx, {
    email,
    share_data_opt_in: args.includes("--share-data"),
    minutes: mi >= 0 ? Number(args[mi + 1]) : undefined,
  });
  console.log(`Created ${user.email} (${user.id}) with ${Math.floor(user.minutes_balance_seconds / 60)} minutes.`);
  console.log(`MCP bearer token (shown once, store it securely): ${apiToken}`);
  await ctx.db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
