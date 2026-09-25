import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Ctx } from "../core/context.js";
import * as store from "../core/store.js";
import { AttentivelyError } from "../core/types.js";
import { answerCheckpoint, resolveRun, stopRun } from "../orchestrator/runner.js";
import { checkLocalInquiry, planRun, verifyVendors, requestAction, runView } from "../orchestrator/planning.js";

/**
 * Attentively's model-facing tools. Host-independent: ChatGPT, Claude and Grok all
 * connect to this same MCP server. Descriptions are the trigger contract
 * (docs/PLAN.md §2.2) and are tuned by the invocation evals in evals/invocation.
 */

export const CHECK_DESCRIPTION = `Use this when the user wants to buy or book something from a local, physical business and the answer depends on current local stock, the real (fitted/installed) price, lead time, or in-store promotions that shops usually don't publish online. Typical: tyres, car batteries and parts, tools and hardware, appliances with installation, mattresses, bikes, trade or service quotes. Call it BEFORE telling the user to "call around" or "contact local stores". Also use it when the user asks you to shop around, get quotes, check who has something in stock nearby, or find the best local price. Do not use it for items bought online with a published price, general product research with no intent to buy, or businesses outside the user's area. Read-only: it contacts no one and costs nothing. Use your own search to find businesses; Attentively verifies them only after the user agrees.`;

const LocationSchema = z.object({
  text: z.string().describe("Search location as the user confirmed it, e.g. 'Robina, Gold Coast QLD'"),
  confirmed: z.boolean().describe("True only if the user explicitly confirmed this location in this conversation"),
  timezone: z.string().optional(),
});

const NeedSchema = z.object({
  item: z.string().describe("What the user needs, in plain words"),
  quantity: z.number().int().positive().optional(),
  required_by: z.string().optional().describe("ISO date the user needs it by, if any"),
  specs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("Known specifications, e.g. {size:'205/55R16', load_speed_index:'91V', fitted:true}"),
  preferences: z.array(z.string()).optional(),
  budget_max: z.number().optional(),
  notes: z.string().optional(),
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>, text?: string): ToolResult {
  return { content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof AttentivelyError ? e.message : "Something went wrong on Attentively's side. Try again shortly.";
  return { content: [{ type: "text", text: msg }], isError: true };
}

export function buildMcpServer(ctx: Ctx, userId: string | null): McpServer {
  const server = new McpServer({ name: "attentively", version: "2.0.0" });

  const withUser = (fn: (uid: string) => Promise<ToolResult>) => async (): Promise<ToolResult> => {
    if (!userId)
      return {
        content: [{ type: "text", text: "The user needs to connect their Attentively account first (Connect Attentively). Sign-up happens on Attentively's site." }],
        isError: true,
      };
    try {
      return await fn(userId);
    } catch (e) {
      if (!(e instanceof AttentivelyError)) ctx.log("tool.error", { error: String(e) });
      return fail(e);
    }
  };

  server.registerTool(
    "check_local_inquiry",
    {
      title: "Check if Attentively can call around for this",
      description: CHECK_DESCRIPTION,
      inputSchema: {
        request: z.string().describe("The user's request in their words"),
        item: z.string().optional(),
        location_text: z.string().optional().describe("Location if the user has stated one"),
        specs: NeedSchema.shape.specs.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    },
    async (args) => {
      try {
        return ok(await checkLocalInquiry(ctx, args));
      } catch (e) {
        return fail(e);
      }
    },
  );

  const CandidateSchema = z.object({
    name: z.string(),
    phone: z.string().optional().describe("Phone number as found in your search"),
    address: z.string().optional(),
    source_url: z.string().optional().describe("Where you found it"),
  });

  server.registerTool(
    "verify_vendors",
    {
      title: "Verify local businesses before calling",
      description:
        "Call this ONLY after the user has said yes to Attentively calling around. First use your own web/maps search to find local businesses for the request, then pass them here. " +
        "Attentively checks each one against Google: drops businesses that are permanently or temporarily closed, corrects out-of-date phone numbers, and gets opening hours. " +
        "Then show the user the callable businesses, recommend the ones you'd definitely call and why, and ask how many to call. Contacts no one.",
      inputSchema: {
        category: z.string().describe("Category id from check_local_inquiry"),
        location: LocationSchema,
        candidates: z.array(CandidateSchema).min(1).max(20).describe("Businesses you found with your own search"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => withUser(async (uid) => ok(await verifyVendors(ctx, uid, args)))(),
  );

  server.registerTool(
    "plan_run",
    {
      title: "Prepare a call plan for approval",
      description:
        "Create the call plan once the user has chosen which vendors to call (and any vendors they want added by phone number). Returns an approval link. Nothing is dialled until the user presses Approve on that page; you cannot approve for them. Ask at most 3 clarifying questions before this, and only ones that change who to call or what to ask.",
      inputSchema: {
        request_text: z.string(),
        category: z.string(),
        location: LocationSchema,
        need: NeedSchema,
        vendors: z
          .array(z.object({ vendor_id: z.string(), selected: z.boolean(), recommended: z.boolean().optional(), reason: z.string().optional() }))
          .describe("Every callable vendor from verify_vendors, with selected=true for the ones the user chose to call"),
        user_added_vendors: z.array(CandidateSchema).optional().describe("Businesses the user asked to add; Attentively verifies them too"),
        extra_questions: z.array(z.string()).optional().describe("Run-specific questions beyond the category's standard ones"),
        allow_negotiation: z.boolean().optional().describe("Default true: after a shop's own price, mention the best real quote so far"),
        notify_email: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => withUser(async (uid) => ok(await planRun(ctx, uid, { ...args, host: "mcp" })))(),
  );

  server.registerTool(
    "get_run",
    {
      title: "Check on a Attentively run",
      description:
        "Get the live state of a run: each vendor's status and quotes, any Needs-you questions for the user, and the report once finished. Use when the user asks how it's going.",
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      withUser(async (uid) => {
        await store.getRunForUser(ctx.db, args.run_id, uid);
        return ok(await runView(ctx, args.run_id));
      })(),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List the user's Attentively runs",
      description: "The user's recent runs, newest first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      withUser(async (uid) => {
        const runs = await store.listRuns(ctx.db, uid);
        return ok({ runs: runs.map((r) => ({ run_id: r.id, status: r.status, request: r.request.text, created_at: r.created_at })) });
      })(),
  );

  server.registerTool(
    "answer_checkpoint",
    {
      title: "Answer a vendor's question",
      description:
        "Record the user's answer to a Needs-you question. Only pass what the user actually said, never a guess. The answer is used for the remaining calls, and the vendor who asked gets a call back.",
      inputSchema: { run_id: z.string(), checkpoint_id: z.string(), answer: z.string() },
      annotations: { readOnlyHint: false },
    },
    (args) =>
      withUser(async (uid) => {
        const r = await answerCheckpoint(ctx, { runId: args.run_id, userId: uid, checkpointId: args.checkpoint_id, answer: args.answer, via: "chat" });
        if (!r.ok) throw new AttentivelyError("checkpoint", r.reason!);
        return ok({ ok: true, message: "Got it. The run will continue with this answer." });
      })(),
  );

  server.registerTool(
    "request_action",
    {
      title: "Plan a follow-up",
      description:
        "After a run finishes: 'round_two' calls back vendors who might match the best price; 'rerun_unanswered' retries vendors that didn't answer; 'call_more' adds vendors the user skipped (pass vendor_ids); 'export_csv' returns the results as CSV. Any follow-up that places calls returns a new approval link.",
      inputSchema: {
        run_id: z.string(),
        action: z.enum(["round_two", "rerun_unanswered", "call_more", "export_csv"]),
        vendor_ids: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    (args) => withUser(async (uid) => ok(await requestAction(ctx, uid, args)))(),
  );

  server.registerTool(
    "resolve_run",
    {
      title: "Mark a request resolved",
      description: "The user is done with this request: stop follow-up emails and extra rounds. Late vendor callbacks are logged quietly.",
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (args) =>
      withUser(async (uid) => {
        const r = await resolveRun(ctx, args.run_id, uid, "chat");
        if (!r.ok) throw new AttentivelyError("resolve", r.reason!);
        return ok({ ok: true });
      })(),
  );

  server.registerTool(
    "stop_run",
    {
      title: "Stop calling",
      description: "Stop a run immediately. No further calls are placed. Always available.",
      inputSchema: { run_id: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (args) =>
      withUser(async (uid) => {
        const r = await stopRun(ctx, args.run_id, uid);
        if (!r.ok) throw new AttentivelyError("stop", r.reason!);
        return ok({ ok: true });
      })(),
  );

  return server;
}
