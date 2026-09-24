# Ringer

Ringer lets an AI assistant (ChatGPT first, then Claude and Grok) **ring local businesses for you**. It checks stock, real prices and promos that shops don't put online, then emails you a comparison.

The assistant decides by itself when Ringer would help. The user approves before anything is dialled. Calls happen one at a time, with a dedicated assistant number so the user's own number is never shared.

- Product plan and decisions: [`docs/PLAN.md`](docs/PLAN.md)
- When the AI should call Ringer: [`evals/invocation`](evals/invocation)

## Quick start (no keys needed)

```bash
npm install
npm run simulate   # a full Gold Coast tyre run against simulated shops
npm test           # 36 tests: approval gate, dialling, Needs-you, negotiation, inbound, memory, HTTP/MCP
npm run dev        # server on http://localhost:8787 (MCP endpoint: /mcp)
```

Everything defaults to **fake providers**, so the whole flow runs locally. This covers embedded Postgres, simulated shops, emails printed to the console, and a board served by Ringer.

### Try it from an AI client

```bash
npm run create-user -- you@example.com --share-data   # prints a bearer token
# Claude Code (developer harness):
claude mcp add --transport http ringer http://localhost:8787/mcp --header "Authorization: Bearer <token>"
```

For ChatGPT developer mode, expose the server over HTTPS (e.g. a tunnel) and add `https://…/mcp` as a connector.

## How it works

```
ChatGPT ──MCP──► check_local_inquiry (read-only, no account needed)   "should I offer Ringer?"
                 find_vendors → user picks how many → plan_run        returns an approval link
User ──► /approve/<signed link> ──► Approve                           the only way calls start
Worker ──► one call at a time, business hours only ──► transcript ──► Claude extraction
       ├─ vendor asks something off-brief → Needs-you email → answer (chat or board) → call back
       ├─ after a vendor's own price → may cite the best real quote so far (name + price)
       └─ done → ranked report + recommended next step, emailed with a board link
Vendor calls/texts/emails the assistant ──► AI answers, recognises them ──► updated report
User presses Resolved ──► no more emails; late info logged quietly
```

| Path | What it is |
|---|---|
| `src/mcp/server.ts` | Model-facing tools and their trigger descriptions |
| `src/orchestrator/runner.ts` | Durable call loop: lease, approval check, hours, minutes, exactly-once dial, checkpoints |
| `src/orchestrator/planning.ts` | Fit check, vendor discovery and verification, plans, follow-ups |
| `src/orchestrator/script.ts` | Per-call voice prompt and the negotiation audit |
| `src/core/ranking.ts` | Deterministic ranking. Conditional promos are never deducted |
| `src/inbound/` | Assistant number and email: callbacks, texts, unknown callers |
| `src/http/` | Approval page, board page (answer / Resolved), webhooks |
| `src/providers/` | Twilio, ElevenLabs, Google Places, Claude, Resend, Kolaboreyt, plus fakes |
| `src/db/schema.sql` | System of record (Postgres). Boards are a projection of it |

## Secrets

All keys come from **environment variables**, read only in `src/config.ts`. See [`.env.example`](.env.example). `.env` files are git-ignored. Production uses the host's secret manager with the same names. Logs redact secret values, and CI runs a secret scan.

## Going live (Phase 0 checklist)

The real provider adapters are written but **not yet run against live accounts**. Each is marked `PHASE 0 VERIFY` in the code.

- [ ] **ElevenLabs:** create the agent, and allow `prompt` and `first_message` overrides. **Switch audio retention off** (transcripts only). Set the conversation-initiation webhook to `/webhooks/voice/inbound-init?secret=…` and the post-call webhook to `/webhooks/voice/post-call?secret=…`. Replace the query-string secret with signature verification.
- [ ] **Twilio:** set up an Australian regulatory bundle and address, buy a test number with `npm run create-user` and `NUMBER_PROVIDER=twilio`, and check that inbound calls reach the agent and SMS reaches `/webhooks/sms`.
- [ ] **Google Places:** check that opening hours and phone numbers come back for Gold Coast tyre shops, and review the licensing terms for storing place data.
- [ ] **Claude extraction:** set `EXTRACTOR_PROVIDER=anthropic` and check extraction against real transcripts (build `evals/extraction`).
- [ ] **Email:** set up Resend (or similar) for sending, plus an inbound email route that posts to `/webhooks/email` with `x-ringer-secret`.
- [ ] **Kolaboreyt:** waiting on the API docs. Implement `src/providers/kolaboreyt.ts`, then set `BOARD_PROVIDER=kolaboreyt`.
- [ ] **Postgres:** set `DATABASE_URL` and `LINK_SIGNING_SECRET`.
- [ ] **Legal:** Queensland call transcription, the AI-disclosure wording, and whether DNC rules apply.
- [ ] **First real run:** one real Gold Coast tyre run by the team, with five vendors.

## Not built yet

These are planned for later phases:
- the ChatGPT UI widgets (Plan card, live board, Results)
- OAuth account linking (a bearer token stands in for now)
- Stripe subscriptions and top-ups
- automated invocation evals
- the vendor inbox
