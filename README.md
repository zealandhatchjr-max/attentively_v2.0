# Attentively v2.0

> Formerly "Ringer". Version 2.0.0.

Attentively lets an AI assistant (ChatGPT first, then Claude and Grok) **ring local businesses for you**. It checks stock, real prices and promos that shops don't put online, then emails you a comparison.

The assistant decides by itself when Attentively would help. The user approves before anything is dialled. Calls happen one at a time, with a dedicated assistant number so the user's own number is never shared.

- Product plan and decisions: [`docs/PLAN.md`](docs/PLAN.md)
- When the AI should call Attentively: [`evals/invocation`](evals/invocation)

## Quick start (no keys needed)

```bash
npm install
npm run simulate   # a full Gold Coast tyre run against simulated shops
npm test           # 54 tests: approval gate, dialling, Needs-you, negotiation, persona, Kolaboreyt, inbound, HTTP/MCP
npm run dev        # server on http://localhost:8787 (MCP endpoint: /mcp)
```

Everything defaults to **fake providers**, so the whole flow runs locally. This covers embedded Postgres, simulated shops, emails printed to the console, and a board served by Attentively.

### Try it from an AI client

```bash
npm run create-user -- you@example.com --share-data   # prints a bearer token
# Claude Code (developer harness):
claude mcp add --transport http attentively http://localhost:8787/mcp --header "Authorization: Bearer <token>"
```

For ChatGPT developer mode, expose the server over HTTPS (e.g. a tunnel) and add `https://…/mcp` as a connector.

## How it works

```
ChatGPT ──MCP──► check_local_inquiry (read-only, no account needed)   "should I offer Attentively?"
ChatGPT searches the web itself (user's subscription) → user says yes
        ──MCP──► verify_vendors: Google check (closed? real phone? hours?)  only after the user agrees
                 user picks how many → plan_run                        returns an approval link
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
| `src/orchestrator/planning.ts` | Fit check, vendor verification (closed / phone / hours, cached), plans, follow-ups |
| `src/orchestrator/script.ts` | Per-call voice prompt and the negotiation audit |
| `src/core/ranking.ts` | Deterministic ranking. Conditional promos are never deducted |
| `src/inbound/` | Assistant number and email: callbacks, texts, unknown callers |
| `src/http/` | Approval page, board page (answer / Resolved), webhooks |
| `src/providers/` | Twilio, ElevenLabs, Google Places, Claude, Resend, Kolaboreyt, plus fakes |
| `src/db/schema.sql` | System of record (Postgres). Boards are a projection of it |

## Who pays for what

The user never needs an API key. They use Attentively through their normal ChatGPT or Claude **subscription**. Their assistant does the research and **finds the businesses with its own search**. Attentively's keys (Google Places, voice, Claude transcript extraction, email) are Attentively's running costs, covered by the Attentively subscription. Google Places is used only **after the user agrees to use Attentively**, to verify the businesses the assistant found:
- It drops **permanently or temporarily closed** businesses. Assistants often still recommend these.
- It corrects out-of-date phone numbers.
- It gets opening hours.

Verifications are cached for 14 days (`VERIFY_MAX_AGE_DAYS`), and lookups are capped per user per day (`PLACES_LOOKUPS_PER_USER_PER_DAY`).

## Voice agent persona

Each user has a named voice agent. Calls open like this:

> "Hi, I'm Maddie, a virtual receptionist calling on behalf of Zealand. I was wondering if you could help me with a quote for 4 x 205/55R16 91V tyres."

Until self-serve onboarding exists (a later phase), set the name, the owner's first name and the voice from the command line:

```bash
npm run create-user -- you@example.com --owner Zealand --assistant Maddie [--voice <elevenlabs-voice-id>]
npm run set-persona -- you@example.com --assistant Sam --default-voice
```

The agent shares only the owner's first name, and always says it's an AI if asked.

## Kolaboreyt board

Quote runs go on one **"Attentively: Quotes"** board, with **one item per request** and **one subitem per vendor**:
- Each vendor's offer fills that subitem's columns.
- Call transcripts are posted as comments.
- Setting the request's Status to **Resolved** in Kolaboreyt stops follow-ups.

The database remains the system of record, and board sync is idempotent. See `src/providers/kolaboreyt.ts`.

## Secrets

All keys come from **environment variables**, read only in `src/config.ts`. See [`.env.example`](.env.example). `.env` files are git-ignored. Production uses the host's secret manager with the same names. Logs redact secret values, and CI runs a secret scan.

## Going live (Phase 0 checklist)

The real provider adapters are written but **not yet run against live accounts**. Each is marked `PHASE 0 VERIFY` in the code.

- [ ] **ElevenLabs:** create the agent, and allow `prompt` and `first_message` overrides. **Switch audio retention off** (transcripts only). Set the conversation-initiation webhook to `/webhooks/voice/inbound-init?secret=…` and the post-call webhook to `/webhooks/voice/post-call?secret=…`. Replace the query-string secret with signature verification.
- [ ] **Twilio:** set up an Australian regulatory bundle and address, buy a test number with `npm run create-user` and `NUMBER_PROVIDER=twilio`, and check that inbound calls reach the agent and SMS reaches `/webhooks/sms`.
- [ ] **Google Places:** check that `businessStatus`, phone numbers and opening hours come back for Gold Coast tyre shops, including a known closed one. Review the licensing terms for caching place data.
- [ ] **Claude extraction:** set `EXTRACTOR_PROVIDER=anthropic` and check extraction against real transcripts (build `evals/extraction`).
- [ ] **Email:** set up Resend (or similar) for sending, plus an inbound email route that posts to `/webhooks/email` with `x-attentively-secret`.
- [ ] **Kolaboreyt:** allow `api.kolaboreyt.com` in the network settings. Put the key (scopes `boards:read`, `boards:write`, `columns:write`, `items:read`, `items:write`) in `KOLABOREYT_API_KEY`. Run `npm run kolaboreyt:check` to find the workspace id, set `KOLABOREYT_WORKSPACE_ID`, then run `npm run kolaboreyt:check -- --setup` and set `BOARD_PROVIDER=kolaboreyt`.
- [ ] **ElevenLabs persona:** allow the `tts.voice_id` override on the agent if users choose voices.
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
