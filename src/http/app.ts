import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getCategory } from "../categories/index.js";
import type { Ctx } from "../core/context.js";
import { verifyLink } from "../core/links.js";
import * as store from "../core/store.js";
import type { TranscriptTurn } from "../core/types.js";
import { inboundCallEnded, inboundCallStarted, inboundMessage } from "../inbound/index.js";
import { buildMcpServer } from "../mcp/server.js";
import { runView } from "../orchestrator/planning.js";
import { advanceRun, answerCheckpoint, approvePlan, resolveRun } from "../orchestrator/runner.js";
import { parseElevenLabsPostCall } from "../providers/elevenlabs.js";
import { approvalPage, boardPage, messagePage } from "./pages.js";

export function buildApp(ctx: Ctx) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  /* ---------- MCP (ChatGPT app / Claude / Grok connectors) ---------- */
  app.post("/mcp", async (req, res) => {
    // Phase 2 replaces this bearer token with OAuth account linking.
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const user = token ? await store.userByToken(ctx.db, token) : null;
    const server = buildMcpServer(ctx, user?.id ?? null);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Use POST" });
  });

  /* ---------- Approval page: the only way calls get approved ---------- */
  app.get("/approve/:token", async (req, res) => {
    const claims = verifyLink(ctx.cfg.linkSecret, req.params.token, "approve");
    if (!claims) return void res.status(404).send(messagePage("Link expired", "This approval link is invalid or has expired. Ask ChatGPT for a fresh plan."));
    const run = await store.getRun(ctx.db, claims.run);
    const plan = await store.getPlan(ctx.db, claims.run, claims.plan);
    if (!run || !plan || run.user_id !== claims.user) return void res.status(404).send(messagePage("Not found", "This plan no longer exists."));
    const user = (await store.getUser(ctx.db, run.user_id))!;
    res.send(
      approvalPage({
        plan,
        requestText: run.request.text,
        questions: getCategory(plan.category).standard_questions(plan.need).concat(plan.questions),
        minutesRemaining: Math.floor(user.minutes_balance_seconds / 60),
        alreadyApproved: await store.hasApproval(ctx.db, run.id, plan.version),
        stale: run.current_plan_version !== plan.version,
        actionUrl: req.originalUrl,
      }),
    );
  });

  app.post("/approve/:token", async (req, res) => {
    const claims = verifyLink(ctx.cfg.linkSecret, req.params.token, "approve");
    if (!claims || claims.plan === undefined) return void res.status(404).send(messagePage("Link expired", "This approval link is invalid or has expired."));
    const r = await approvePlan(ctx, { runId: claims.run, userId: claims.user, planVersion: claims.plan, method: "approval_page" });
    if (!r.ok) return void res.status(409).send(messagePage("Not approved", r.reason!));
    void advanceRun(ctx, claims.run).catch((e) => ctx.log("advance.failed", { error: String(e) }));
    res.send(messagePage("Approved", "Calls are starting. We'll email you if a vendor asks something only you can answer, and again with the report."));
  });

  /* ---------- Board (share link): view, answer Needs-you, Resolved ---------- */
  app.get("/b/:token", async (req, res) => {
    const claims = verifyLink(ctx.cfg.linkSecret, req.params.token, "board");
    if (!claims) return void res.status(404).send(messagePage("Link expired", "This board link is invalid or has expired."));
    const view = await runView(ctx, claims.run);
    const calls = await store.runCalls(ctx.db, claims.run);
    res.send(
      boardPage({
        requestText: view.request,
        location: view.location,
        status: view.status,
        resolved: view.resolved,
        nextStep: (view.report as { next_step?: string } | null)?.next_step,
        vendors: view.vendors.map((v) => ({
          name: v.name,
          phone: v.phone,
          status: v.status,
          offers: v.offers,
          calls: calls
            .filter((c) => c.vendor_id === v.vendor_id)
            .map((c) => ({ direction: c.direction, summary: c.summary, transcript: (c.transcript as TranscriptTurn[] | null) ?? [] })),
        })),
        needsYou: view.needs_you.map((n) => ({ id: n.checkpoint_id, vendor: n.vendor ?? "", question: n.question, why: n.why })),
        answerUrl: `${req.originalUrl}/answer`,
        resolveUrl: `${req.originalUrl}/resolve`,
      }),
    );
  });

  app.post("/b/:token/answer", async (req, res) => {
    const claims = verifyLink(ctx.cfg.linkSecret, req.params.token, "board");
    if (!claims) return void res.status(404).send(messagePage("Link expired", "This board link is invalid or has expired."));
    const answer = String(req.body.answer ?? "").trim();
    if (!answer) return void res.status(400).send(messagePage("Missing answer", "Please type an answer."));
    const r = await answerCheckpoint(ctx, { runId: claims.run, userId: claims.user, checkpointId: String(req.body.checkpoint_id), answer, via: "board" });
    if (r.ok) void advanceRun(ctx, claims.run).catch((e) => ctx.log("advance.failed", { error: String(e) }));
    res.redirect(303, `/b/${req.params.token}`);
  });

  app.post("/b/:token/resolve", async (req, res) => {
    const claims = verifyLink(ctx.cfg.linkSecret, req.params.token, "board");
    if (!claims) return void res.status(404).send(messagePage("Link expired", "This board link is invalid or has expired."));
    await resolveRun(ctx, claims.run, claims.user, "board");
    res.redirect(303, `/b/${req.params.token}`);
  });

  /* ---------- Voice webhooks (ElevenLabs) ---------- */
  const voiceAuth = (req: Request, res: Response): boolean => {
    const secret = ctx.cfg.ELEVENLABS_WEBHOOK_SECRET;
    if (!secret) return ctx.cfg.NODE_ENV !== "production" || (res.status(503).end(), false);
    // PHASE 0 VERIFY: switch to ElevenLabs HMAC signature header once confirmed.
    if (req.query.secret === secret) return true;
    res.status(401).end();
    return false;
  };

  // Conversation-initiation webhook: who is calling the assistant number, and what do we know?
  app.post("/webhooks/voice/inbound-init", async (req, res) => {
    if (!voiceAuth(req, res)) return;
    const c = await inboundCallStarted(ctx, { agentNumber: String(req.body.called_number ?? ""), callerNumber: String(req.body.caller_id ?? "") });
    res.json({
      type: "conversation_initiation_client_data",
      dynamic_variables: c.dynamicVariables,
      conversation_config_override: { agent: { prompt: { prompt: c.systemPrompt }, first_message: c.firstMessage } },
    });
  });

  app.post("/webhooks/voice/post-call", async (req, res) => {
    if (!voiceAuth(req, res)) return;
    const p = parseElevenLabsPostCall(req.body);
    if (!p) return void res.status(400).end();
    if (p.direction === "outbound") {
      const call = await store.callByProviderId(ctx.db, ctx.providers.voice.name, p.providerCallId);
      if (call?.run_id) await store.scheduleRun(ctx.db, call.run_id, ctx.now());
    } else {
      await inboundCallEnded(ctx, {
        provider: ctx.providers.voice.name,
        providerCallId: p.providerCallId,
        agentNumber: p.agentNumber ?? "",
        callerNumber: p.callerNumber ?? "",
        durationSec: p.durationSec ?? 0,
        transcript: p.transcript,
      });
    }
    res.json({ ok: true });
  });

  /* ---------- Written replies to the assistant ---------- */
  app.post("/webhooks/sms", async (req, res) => {
    if (!twilioSignatureOk(ctx, req)) return void res.status(401).end();
    await inboundMessage(ctx, { channel: "sms", to: String(req.body.To ?? ""), from: String(req.body.From ?? ""), body: String(req.body.Body ?? "") });
    res.type("text/xml").send("<Response></Response>");
  });

  app.post("/webhooks/email", async (req, res) => {
    const secret = ctx.cfg.INBOUND_EMAIL_WEBHOOK_SECRET;
    if (secret && req.headers["x-ringer-secret"] !== secret) return void res.status(401).end();
    if (!secret && ctx.cfg.NODE_ENV === "production") return void res.status(503).end();
    const b = req.body ?? {};
    await inboundMessage(ctx, { channel: "email", to: String(b.to ?? ""), from: String(b.from ?? ""), subject: b.subject, body: String(b.text ?? b.body ?? "") });
    res.json({ ok: true });
  });

  return app;
}

/** Validates Twilio's X-Twilio-Signature (HMAC-SHA1 over URL + sorted POST params). */
function twilioSignatureOk(ctx: Ctx, req: Request): boolean {
  const token = ctx.cfg.TWILIO_AUTH_TOKEN;
  if (!token) return ctx.cfg.NODE_ENV !== "production";
  const sig = req.headers["x-twilio-signature"];
  if (typeof sig !== "string") return false;
  const url = `${ctx.cfg.RINGER_BASE_URL}${req.originalUrl}`;
  const params = req.body as Record<string, string>;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac("sha1", token).update(data).digest();
  const given = Buffer.from(sig, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
