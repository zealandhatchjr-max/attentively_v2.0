# Ringer: ChatGPT App Build Plan

Status: Draft plan, building on the Ringer PRD (Draft for product and engineering review)
Launch surface: **ChatGPT app** (Apps SDK / MCP). Grok and Claude connectors reuse the same MCP server later.

---

## 0. What this plan changes from the PRD

The PRD still holds. This plan changes five things so it fits ChatGPT and the goal that **the assistant decides on its own to use Ringer**:

| # | PRD assumption | Change | Why |
|---|---|---|---|
| 1 | Grok ships first | **ChatGPT ships first.** Grok and Claude follow on the same MCP core. | ChatGPT apps are MCP servers with optional UI widgets. Claude and Grok also speak MCP, so the adapter layer stays thin and the order is a distribution choice, not an architecture choice. |
| 2 | The user or host explicitly starts Ringer | **The model invokes Ringer itself** when it sees a local-buy-with-hidden-stock situation. This needs a new cheap, safe entry tool and invocation evals (§2). | This is the core product behaviour you described. |
| 3 | The host assistant runs the call loop (`place_call` → `wait_for_call` → checkpoint → next) | **Ringer runs the loop server-side.** The host only plans, approves, answers checkpoints, and presents results. | A five-call run takes 20–40 minutes. A ChatGPT turn ends long before that, and the model does not run between user messages. A long-blocking `wait_for_call` would time out. |
| 4 | Checkpoint reasoning happens in the host model | **Ringer's own LLM** does extraction and in-brief/out-of-brief classification after each call. Anything that needs a human becomes *Needs you*. | Same reason: nobody is "in the chat" while calls run. |
| 5 | Standalone entry point comes in Phase 5 | **Email notifications and a board link (Kolaboreyt) ship in the MVP.** | ChatGPT cannot reliably post into a conversation on its own later. Ringer needs its own way to reach the user (an email linking to the Kolaboreyt board) for *Needs you* and *Done*. |

Also: open decision #6 (call cap) is resolved. **There is no fixed default.** The AI shows the user every suitable vendor it found, says which ones it would definitely call and why, and **asks how many to call** (§2.4). A system-wide safety ceiling set in config stays in place to protect against runaway cost.

---

## 1. The product in one flow

```
User: "My front tyre's got a bulge, here's a photo. Need 4 new ones this week, I'm in Robina."
  │
  ▼
ChatGPT model sees: physical product + local fitting + price/stock rarely online
  │  → calls ringer.check_local_inquiry   (read-only, no cost, no auth needed)
  ▼
Ringer returns: "good fit", category=tyres, the fields it needs, what's missing
  │
  ▼
Model reads the size off the photo (e.g. 205/55R16 91V), researches, asks ≤3 questions
  ("Fitted & balanced? Budget or mid-range brands? Need it by Friday?")
  │
  ▼
Model calls ringer.plan_run → widget renders the PLAN CARD
  "I found 10 local vendors. I'd definitely call Beaurepaires Robina (07 …) and
   Tyrepower Varsity Lakes (07 …), they list your size. How many would you like me to call?"
  User: "Call 4"
  (location, spec, the 4 chosen + the others listed, script, cost, AI/recording notice)
  │
  ▼
User taps [Approve]  ← approval is a UI event tied to the user, not something the model asserts
  │
  ▼
Ringer orchestrator: call 1 → extract → brief v2 → call 2 → ... (sequential, business hours)
  │            │
  │            └─ vendor asks "which load rating?" and it's not in the brief
  │                → vendor item = NEEDS YOU, run pauses, email to user
  ▼
User answers (in ChatGPT, on the widget, or on the Kolaboreyt board) → brief v3 → run resumes
  │
  ▼
Run complete → email → user opens chat → model calls get_run → RESULTS CARD
  Best overall / cheapest valid / fastest, with evidence links per claim
  │
  ▼
"Book the Friday 2pm slot at Beaurepaires Robina" → request_action → separate approval
```

---

## 2. Autonomous invocation (the key new work)

In ChatGPT, the model decides whether to call a tool from the tool's **name, description, input schema and annotations**. Making Ringer fire at the right moments and stay quiet otherwise is a design and testing task in its own right.

### 2.1 Split "should we use Ringer?" from "spend money"

Autonomous invocation is only safe if the first call is free and harmless. So:

- **`check_local_inquiry`**: read-only (`readOnlyHint: true`), no side effects, no auth required. The model can call it whenever it *suspects* a fit. It returns:
  - `fit`: `strong | possible | poor`, with a reason
  - `category` and the category's answer schema (for tyres: size, load/speed index, brand tier, fitted price, stock, lead time, promo, warranty, validity)
  - `missing_fields`: what must be clarified before planning
  - `coverage`: whether Ringer operates in the location (Gold Coast only at launch)
  - `prior_observations`: recent vendor-memory hits ("3 quotes for this size in Robina in the last 7 days")
  - `suggested_user_message`: a short line the model can use to offer the service
- Everything that costs money or contacts a third party (`start_run`, `request_action`) has side effects, needs auth, and **needs an approval token that only a user UI action can create** (§4).

The model's autonomy therefore stops at **"offer and prepare a plan"**. It never extends to dialing.

### 2.2 Tool description: the trigger contract

Draft description for `check_local_inquiry`, to be tuned by the evals in §2.3:

> Use this when the user wants to **buy or book something from a local, physical business** and the answer depends on **current local stock, fitted/installed price, lead time, or in-store promotions that shops usually don't publish online**. Typical: tyres, car batteries, auto parts, tools and hardware, appliances with install, mattresses, bikes, trade quotes. Call it **before** telling the user to "call around" or "contact local stores". Also use it when the user asks you to shop around, get quotes, check who has it in stock nearby, or find the best local price. Do **not** use it for items that can be bought online and shipped with a published price, for general product research with no intent to buy, or for businesses outside the user's area.

Rules for writing tool metadata:
- **Name the moment, not the mechanism.** The model matches "the user needs to call around", not "outbound telephony".
- **Name the anti-pattern it replaces:** "Call it before telling the user to call around". This is the strongest trigger.
- **List the negatives**, so the model doesn't fire on "what's the best tyre brand?"
- **Categories are config, not code.** Tyres, guns and tools were only examples. Any category can be added to the registry. The only exclusions are those the host platform's policy forces, and they live in one config list (see §8, risk R1).

### 2.3 Invocation eval set (built in Phase 1, gates every release)

Build a labelled prompt set (~150 prompts to start) and run it against ChatGPT developer mode on every metadata change:

| Bucket | Examples | Expected |
|---|---|---|
| Direct | "Ring around and find me 4× 205/55R16 fitted this week" | `check_local_inquiry` → plan |
| Implicit | "Tyre's got a bulge, where should I get new ones on the Goldy?" | `check_local_inquiry`, then an offer |
| Implicit via image | Photo of sidewall + "need these replaced" | call; spec pulled from the image |
| Near-miss (should not fire) | "Michelin vs Continental for wet grip?" | no call |
| Online-buyable | "Cheapest AirPods?" | no call |
| Out of coverage | "Tyres in Perth" | call → `coverage: none` → model says so gracefully |
| Platform-restricted | Whatever the ChatGPT policy list excludes (checked in Phase 0) | no call; if called, `fit: poor, reason: unsupported_on_host` |
| Multi-turn drift | Research chat that turns into "ok who has it cheapest near me?" | fires at the turn where intent appears |

Metrics: precision and recall of invocation, false-positive rate on near-misses, and whether the model asks ≤3 questions before `plan_run`.

### 2.4 The user chooses how many vendors to call

There is no fixed call count. After research, the AI shows the user **everything it found** and makes a recommendation:

> "I found 10 local tyre shops that fit fitted tyres in Robina. I'd definitely call **Beaurepaires Robina (07 …)** and **Tyrepower Varsity Lakes (07 …)**, because both list 205/55R16 in their range and are open Saturday. Kmart Tyre & Auto is the closest but often out of stock in this size. How many would you like me to call? I'll go one at a time, best bets first."

What this means for the build:
- `plan_run` returns **all** candidates, each with a `recommended` flag, a short `reason` and its phone number. Call order is recommended picks first, then the rest by the ranking rules.
- The Plan card shows the full list with the recommended ones pre-ticked. The user can tick or untick vendors or just type a number. The cost estimate updates as they change it.
- The chosen number and vendor list are part of the approved plan version. Calling more vendors later ("try 2 more") needs a new approval.
- A system-wide **safety ceiling** (config, not user-facing by default) stops a single run from placing an unreasonable number of calls.

---

## 3. Architecture

```
┌──────────────── ChatGPT ────────────────┐
│  Model  ──tools──►  Ringer MCP server   │
│  Widget iframe (plan / board / results) │──► Ringer API (same backend)
└─────────────────────────────────────────┘
                     │
        ┌────────────┴─────────────────────────────────────────┐
        │                 Ringer core (host-independent)       │
        │  Run service ─ Orchestrator (durable workflow)       │
        │  Vendor service (canonical IDs, DNC, hours, memory)  │
        │  Extraction/checkpoint LLM                           │
        │  Approval + audit log (append-only)                  │
        │  Notification service (email)                        │
        │  Board sync (existing board tool, best-effort)       │
        └────────────┬─────────────────────────────────────────┘
          Telephony interface │ Voice-agent interface │ Places interface
             (Twilio)         │ (ElevenLabs)          │ (Google Places)
```

Key choices:

- **One MCP server, host adapters as config.** The core tool contract carries no ChatGPT-specific fields. ChatGPT-only extras (widget template references, `_meta`) are added in a thin adapter layer.
- **Durable orchestrator.** Use Temporal, Inngest, or a Postgres-backed job queue. One workflow per run, one activity per call. This gives restart survival, webhook replay safety and sequential execution without inventing them. Pick whichever the team knows. The requirement is durability plus exactly-once dialing.
- **Idempotent dialing.** Each dial is keyed by `(run_id, vendor_id, attempt_no, brief_version)`. The telephony adapter refuses a second dial with the same key.
- **Postgres is the system of record.** The existing board tool is a projection, synced asynchronously. A board failure never blocks or loses a call (PRD §14).
- **Server-side vendor verification.** The ChatGPT model can suggest candidate vendors from its web search. Ringer re-resolves each one via a places API for phone, hours and address before it goes in a plan, because phone numbers from model search results are the most likely thing to be wrong.
- **Widgets read Ringer directly.** The board widget polls `get_run` (or subscribes) through the Apps SDK widget bridge, so progress updates without the model taking a turn.

### 3.1 Secrets and API keys

Every API key and secret comes from **environment variables**. None are hard-coded or committed.

- Code reads secrets only through one typed config module (`packages/core/config`). It validates at startup and fails fast if a required variable is missing. No other code reads `process.env` directly.
- `.env.example` in the repo lists every variable name with an empty value. Real `.env` files are git-ignored.
- Local dev uses a `.env` file. Staging and production inject the same variable names from the hosting platform's secret manager (e.g. Fly/Render secrets, AWS Secrets Manager, GCP Secret Manager). The names stay the same and only the source changes.
- Use separate keys per environment (dev, staging, prod), so a leaked dev key can't dial real vendors or bill real users.
- Secrets never appear in tool responses, widget payloads, logs, transcripts or error messages. They never reach ChatGPT or any other host model (PRD §9, §14). The logger redacts known secret variable names.
- CI runs secret scanning on every push. Keys are rotated on a schedule and immediately after any suspected leak.

Suggested stack, open to change: TypeScript, the official MCP TypeScript SDK, Postgres, a durable workflow engine, React widgets, Twilio + ElevenLabs outbound (validated in Phase 0), and OAuth 2.1 for account linking.

---

## 4. Revised tool contract

Model-facing tools. Everything is scoped to the authenticated user, and every mutating tool takes an `idempotency_key`.

| Tool | Side effects | Auth | Purpose |
|---|---|---|---|
| `check_local_inquiry` | none (read-only) | optional | Fit check, category schema, missing fields, coverage, prior observations. **The autonomous entry point.** |
| `plan_run` | creates a draft run and plan version | required | Validates location, spec, **all** found vendors (re-resolved server-side) with the AI's recommended picks marked, the number of calls **the user chose**, questions, ranking rules, and cost estimate. Returns `plan_version` and renders the **Plan card** widget. |
| `start_run` | dials | required + **approval token** | Starts the orchestrator for an approved `plan_version`. Fails if the token is missing, stale or already used. |
| `get_run` | none | required | Full state: vendor items, observations with evidence, open checkpoints, current recommendation inputs. Renders the **Board** or **Results** widget. |
| `answer_checkpoint` | new brief version | required | Records the user's answer and resumes the run. A material scope change (budget, cap, identity disclosure) returns `needs_reapproval` instead. |
| `request_action` | prepares an action | required | Booking call, callback, calendar, CSV/PDF export, rerun unanswered. Booking and callback need their own approval token. |
| `list_runs` | none | required | History. |
| `stop_run` | stops | required | Immediate stop. Always available, no token needed. |

Replaced from the PRD: `place_call`, `get_call`, `wait_for_call` and `save_result` become orchestrator internals (change #3). `approve_run` becomes a **widget-only action**, not a model tool. `vendor_memory` is folded into `check_local_inquiry` and `plan_run`.

**How approval works:** the Plan card's *Approve* button calls a Ringer endpoint from the widget with the user's session. Ringer records `approval{user_id, plan_version, ui_event, timestamp}` and returns a one-time token. The model then calls `start_run(token)`. The model cannot produce an approval on its own, which satisfies "zero calls without a matching approval event". If the widget bridge can't support this cleanly, the fallback is a `start_run` gated by ChatGPT's own write-action confirmation, plus Ringer's plan-version check. Phase 0 decides which.

---

## 5. Async UX in ChatGPT (the hard part)

| Moment | Where the user sees it |
|---|---|
| Plan | Plan card widget inline in the chat |
| Calls in progress | Board widget (live-polls Ringer). The user can leave. |
| **Needs you** | Email containing the exact question + a link to the run's **Kolaboreyt board**. The answer can come from the board, the widget, or by telling ChatGPT. |
| Done | Email + Kolaboreyt board link. Back in ChatGPT, "how did it go?" → `get_run` → Results card. |
| Vendor callback | The vendor calls the Ringer number back. The inbound agent looks up the run by caller ID and handles it. (Reuses the existing inbound Twilio/ElevenLabs stack.) |

The **Kolaboreyt board** does the job of the standalone run page. Users can follow and answer a run there without ChatGPT, which is also the hedge against marketplace risk. (This assumes Kolaboreyt is the existing board tool from the PRD. See §9.)

The user confirms their email for notifications on the Plan card, before approving.

---

## 6. Delivery phases

Durations assume 2–3 engineers. Treat them as sizing, not commitments.

### Phase 0: Audit and spikes (1–2 weeks)
- Audit the existing inbound Twilio + ElevenLabs code: can it do **outbound** with a **per-call prompt override** and a **structured data-collection schema**? Record reuse, modify or rebuild for each component.
- Spike a ChatGPT dev-mode app: a hello-world MCP tool, a widget, OAuth account linking, and a widget → backend call (to validate the approval-token flow in §4).
- Spike the existing board-tool API: create board, adaptive columns, item updates.
- Legal: Queensland recording position, AI-disclosure script, whether B2B inquiry calls fall outside telemarketing/DNC rules, and OpenAI app policy fit (see R1).
- **Exit:** signed ADR, one outbound test call to a team phone with an overridden prompt and structured extraction, one widget rendering in ChatGPT dev mode.

### Phase 1: Core and first real run (3–4 weeks)
- Postgres schema (Run, PlanVersion, Approval, BriefVersion, Vendor, Call, Observation, Checkpoint, AuditEvent).
- Orchestrator: sequential loop, business-hours gate, cap, idempotent dial, extraction, brief versioning, *Needs you* pause/resume.
- Category registry with **one category: tyres** (answer schema, ranking rules, call script template).
- MCP server with the §4 tools. Test it first through **MCP Inspector and Claude Code** as the developer harness (no UI dependency).
- Invocation eval set v1 (§2.3).
- **Exit (PRD milestone):** one real Gold Coast tyre run, five sequential vendor calls, complete evidence, at least one checkpoint, and a ranked recommendation on one board.

### Phase 2: ChatGPT app and reliability (3–4 weeks)
- Widgets: Plan card, Board, Needs-you prompt, Results with evidence drill-down.
- Approval-token flow, OAuth account linking, email notification service, Kolaboreyt board links and the answer-from-board flow.
- DNC store, duplicate-call protection, retry policy, webhook replay safety, vendor canonicalisation, vendor memory in `check_local_inquiry`.
- Tune invocation metadata until eval targets are met: e.g. ≥90% recall on direct/implicit and ≤5% false positives on near-misses.
- **10 supervised internal runs** from ChatGPT dev mode.
- **Exit:** PRD MVP metrics met (§15) or gaps documented and accepted.

### Phase 3: Private pilot (3–4 weeks)
- Invited testers on managed company keys, no charging. Human review of recommendations before they're shown, if §9 decides that.
- Booking and callback actions with separate approval.
- Instrumentation: cost per usable quote, vendor answer and decline rates, time-to-recommendation.
- **Exit:** testers complete runs without developer intervention, and usefulness is ≥4/5.

### Phase 4: Public listing and billing
- App directory submission (privacy policy, safety review, tool annotations accurate), Stripe on the Ringer account, allowances, support tooling, formal legal sign-off, retention and deletion controls.

### Phase 5: Cross-host and next verticals
- Grok and Claude connectors on the same MCP server (mostly config plus widget fallbacks to text/markdown).
- Second category (e.g. car batteries or tool hire), added through the category registry with no core changes.

### Phase 6: Vendor inbox (unchanged from the PRD)

---

## 7. Repo layout (proposed)

```
/apps
  /mcp-server        MCP tools, host adapters (chatgpt/, claude/, grok/)
  /widgets           React widgets: plan-card, board, needs-you, results
  /run-page          minimal standalone web view
/packages
  /core              run/plan/brief/approval domain + state machines
  /orchestrator      durable workflow, call loop, checkpoint logic
  /categories        category registry (tyres first): schema, script, ranking
  /providers         telephony, voice-agent, places, board, notify interfaces + impls
  /db                schema + migrations
/evals
  /invocation        labelled prompts + runner
  /extraction        transcript → observation golden set
/docs                PRD, this plan, ADRs
```

---

## 8. Risks specific to this plan

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Some categories may break a host's listing policy** (weapons, for example). Ringer itself doesn't restrict categories, but a marketplace can reject or pull an app over them. | Keep one per-host exclusion list in config. Check OpenAI's current app policy in Phase 0. Leave excluded categories out of that host's tool descriptions. Other hosts or the Kolaboreyt entry point can still serve them if their policies allow. |
| R2 | The model over-triggers (annoying) or under-triggers (invisible product) | Eval set (§2.3) gates releases. A read-only entry tool makes over-triggering cheap and harmless. |
| R3 | The user never comes back to the chat | Email + Kolaboreyt board (§5). Results are never locked inside ChatGPT. |
| R4 | The model fabricates or garbles vendor phone numbers | Ringer re-resolves every vendor server-side before planning (§3). |
| R5 | The model asserts approval without the user | Approval token only from a UI event (§4). An audit test in CI tries `start_run` without a token. |
| R6 | ChatGPT platform or policy change | Core is host-independent. Claude/Grok adapters and the Kolaboreyt board are the fallback distribution. |
| R7 | Tyre spec misread from the photo | The spec is always echoed on the Plan card for confirmation. Load/speed index is a required confirmed field. |

The PRD's other risks (vendor rejection, extraction errors, recording law, cost) stand as written.

---

## 9. Decisions

**Resolved**
- ✅ **ChatGPT first.**
- ✅ **Number of calls:** the user chooses for each run. The AI lists every vendor it found, recommends the ones it would definitely call (with phone numbers and reasons), and asks how many to call (§2.4). A config safety ceiling still applies.
- ✅ **Notifications:** email, linking to the run's Kolaboreyt board.
- ✅ **Categories:** not restricted by product choice. Tyres, guns and tools were examples. Exclusions come only from host policy (R1).

**Still open**
1. **Confirm Kolaboreyt is the existing board tool** from the PRD, and that each run can get a shareable or authenticated board link to put in emails.
2. **Approval mechanism:** widget-issued token (preferred) or host write-confirmation. Phase 0 spike decides.
3. **Orchestrator tech:** Temporal vs Inngest vs a Postgres queue.
4. **Vendor discovery source:** Google Places vs an alternative, and its licensing for storing vendor data in vendor memory.
5. **Email provider** (e.g. Postmark, SES, Resend).
6. **Safety ceiling value** for calls per run (config, e.g. 10–15).
7. The remaining PRD §21 decisions (recording, disclosure defaults, pilot pricing, retention, human review).

---

## 10. Next concrete steps (this week)

1. Answer the open §9 decisions, starting with Kolaboreyt.
2. Give engineering access to the existing inbound Twilio/ElevenLabs code and the board-tool API docs.
3. Start the Phase 0 spikes in parallel: outbound call with prompt override, ChatGPT dev-mode widget + OAuth, board API.
4. Draft the invocation eval prompts. Anyone on the team can write these, and it's the fastest way to sharpen *when* Ringer should appear.
5. Book the legal consult (Queensland recording, AI disclosure, DNC applicability, platform policy for restricted goods).
