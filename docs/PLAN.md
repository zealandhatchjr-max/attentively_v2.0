# Attentively v2.0: ChatGPT App Build Plan

> **Naming:** this project was called "Ringer" until v2.0 and is now **Attentively v2.0** (repo being renamed `ringring` → `attentively`). It is separate from the developer's existing inbound app (`Simply-Expanding/attentively`), which this project does not change.

Status: Draft plan, building on the Attentively PRD (Draft for product and engineering review)
Launch surface: **ChatGPT app** (Apps SDK / MCP). Grok and Claude connectors reuse the same MCP server later.

---

## 0. What this plan changes from the PRD

The PRD still holds. This plan changes five things so it fits ChatGPT and the goal that **the assistant decides on its own to use Attentively**:

| # | PRD assumption | Change | Why |
|---|---|---|---|
| 1 | Grok ships first | **ChatGPT ships first.** Grok and Claude follow on the same MCP core. | ChatGPT apps are MCP servers with optional UI widgets. Claude and Grok also speak MCP, so the adapter layer stays thin and the order is a distribution choice, not an architecture choice. |
| 2 | The user or host explicitly starts Attentively | **The model invokes Attentively itself** when it sees a local-buy-with-hidden-stock situation. This needs a new cheap, safe entry tool and invocation evals (§2). | This is the core product behaviour you described. |
| 3 | The host assistant runs the call loop (`place_call` → `wait_for_call` → checkpoint → next) | **Attentively runs the loop server-side.** The host only plans, approves, answers checkpoints, and presents results. | A five-call run takes 20–40 minutes. A ChatGPT turn ends long before that, and the model does not run between user messages. A long-blocking `wait_for_call` would time out. |
| 4 | Checkpoint reasoning happens in the host model | **Attentively's own LLM** does extraction and in-brief/out-of-brief classification after each call. Anything that needs a human becomes *Needs you*. | Same reason: nobody is "in the chat" while calls run. |
| 5 | Standalone entry point comes in Phase 5 | **Email notifications and a board link (Kolaboreyt) ship in the MVP.** | ChatGPT cannot reliably post into a conversation on its own later. Attentively needs its own way to reach the user (an email linking to the Kolaboreyt board) for *Needs you* and *Done*. |

Also: open decision #6 (call cap) is resolved. **There is no fixed default.** The AI shows the user every suitable vendor it found, says which ones it would definitely call and why, and **asks how many to call** (§2.4). A system-wide safety ceiling set in config stays in place to protect against runaway cost.

---

## 1. The product in one flow

```
User: "My front tyre's got a bulge, here's a photo. Need 4 new ones this week, I'm in Robina."
  │
  ▼
ChatGPT model sees: physical product + local fitting + price/stock rarely online
  │  → calls attentively.check_local_inquiry   (read-only, no cost, no auth needed)
  ▼
Attentively returns: "good fit", category=tyres, the fields it needs, what's missing
  │
  ▼
Model reads the size off the photo (e.g. 205/55R16 91V), researches, asks ≤3 questions
  ("Fitted & balanced? Budget or mid-range brands? Need it by Friday?")
  │
  ▼
Model calls attentively.plan_run → widget renders the PLAN CARD
  "I found 10 local vendors. I'd definitely call Beaurepaires Robina (07 …) and
   Tyrepower Varsity Lakes (07 …), they list your size. How many would you like me to call?"
  User: "Call 4"
  (location, spec, the 4 chosen + the others listed, script, cost, AI/recording notice)
  │
  ▼
User taps [Approve]  ← approval is a UI event tied to the user, not something the model asserts
  │
  ▼
Attentively orchestrator: call 1 → extract → brief v2 → call 2 → ... (sequential, business hours)
  │            │
  │            └─ vendor asks "which load rating?" and it's not in the brief
  │                → vendor item = NEEDS YOU, run pauses, email to user
  ▼
User answers (in ChatGPT, on the widget, or on the Kolaboreyt board) → brief v3 → run resumes
  │
  ▼
Run complete → REPORT emailed (+ Kolaboreyt board) → user opens chat → get_run → RESULTS CARD
  Best overall / cheapest valid / fastest, evidence per claim, and a RECOMMENDED NEXT STEP
  ("Call Tyrepower on 07 … and mention quote #R-1042, valid until Friday")
  │
  ▼
Optional: "Beaurepaires might match $580, want me to call them back?" → user approves round 2
  │
  ▼
Vendor calls the user's assistant number later → inbound AI recognises them → notes added
  → updated report emailed, until the user presses [Resolved]
```

---

## 1.0 Build status (2026-09-24)

The Phase 1 core is built and tested with simulated providers. See README.md for what's real, what's faked, and the Phase 0 go-live checklist.

## 1.0a Changes in v2.0 (2026-09-25)
- **Renamed** Ringer → Attentively, version 2.0.0.
- **Voice agent persona.** Each user has a named voice agent: name, voice, and the user's first name. Calls open: *"Hi, I'm Maddie, a virtual receptionist calling on behalf of Zealand. I was wondering if you could help me with a quote for…"*. "Maddie" is Zealand's choice and the default.
  - A **self-serve onboarding flow** where users choose the name and voice is a **later phase**. Until then these are set with `create-user` / `set-persona`.
- **AI honesty rule** (every prompt): if asked whether it's a person or an AI, the agent always says it's an AI assistant and never claims to be human. Only the owner's **first name** is ever shared.
  - "Virtual receptionist" plus this rule replaces the old "I'm an AI assistant" opener. That wording is on the legal-review list.
- **Transcription notice** is now a flag (`TRANSCRIPTION_NOTICE`, default off) pending legal advice.
- **Kolaboreyt board is live in code** (see the updated decision below). Emails still link to Attentively's own board page.

## 1.1 Product decisions (from founder Q&A, 2026-09-24)

These override the PRD where they conflict.

**Identity: every user gets their own assistant number**
- Each subscriber gets a **dedicated Twilio number** that works like a celebrity's assistant line. The user's real number is **never** given to vendors.
- Vendors hear the user's voice agent: "Hi, I'm Maddie, a virtual receptionist calling on behalf of Zealand…" (v2.0; see §1.0a). If asked for a number, the agent gives the assistant number: "You can reach me on this number."
- Attentively is **gathering information only**. The MVP makes no bookings, holds or payments.

**Inbound: the assistant number is always answered by the AI**
- Every inbound call to a user's number goes to the voice agent.
- On ring, the agent looks up the caller's number against Attentively's database: which vendor is this, and which runs and calls have we had with them for this user? It then loads the previous call's notes and transcript summary into its context ("Hi, thanks for calling back about the 205/55R16 tyres…").
- Unknown callers (including the user's own phone, since the user doesn't know the number) get a polite receptionist flow: take a message, attach it to the user's account, and email the user.
- Everything a callback captures lands on the run's Kolaboreyt board as a new call record with the same evidence rules as outbound calls.

**Negotiation**
- On each call, the AI **first gets the vendor's own price without mentioning any competitor**.
- After that, it may share a **real** competing quote from this run, **naming the competitor and the price** ("Tyrepower Varsity Lakes quoted $620 fitted for the same tyre, can you do better?").
- Only quotes actually collected, with evidence, can be used. The AI never bluffs or rounds a quote in its favour. The board records the price before and after negotiation as separate observations.
- **Second round:** earlier vendors never heard the later, lower quotes. So the report can suggest going back ("Beaurepaires might match $580, want me to call them back?"). The call-back round only happens after the **user approves** it.

**Report and next step**
- When the run finishes, Attentively emails a **report** (and updates the Kolaboreyt board) with what it found, the ranking, the evidence and a **recommended next step**. The user acts on it themselves.

**Timing**
- Requests outside business hours are **queued**. The user approves the plan now, and each call is placed when that shop opens. The report arrives later, with the expected time shown on the Plan card.

**Late information and "Resolved"**
- A vendor callback after the report has gone out **always triggers an updated report email**.
- Every run has a **Resolved** button (in the email, on the Kolaboreyt board and in the ChatGPT widget). Once resolved, the run gets no more emails or rounds, and late callbacks are logged quietly. The inbound AI tells the vendor the customer has sorted it, thanks them, and takes no further details.

**Billing: subscription with included minutes** (paid plans arrive in Phase 4. The team pilot is free.)
- **All call time counts**, including ringing, hold time, voicemail and inbound callbacks.
- **Running out mid-run:** the run pauses before the next call and emails the user "Out of minutes: top up, or get the report with what we have?"
- The Plan card shows the estimated minutes against the user's remaining balance.

**Sign-up**
- First use in ChatGPT shows **"Connect Attentively"**. Sign-up, subscription and assistant-number setup happen **on Attentively's own site** (OAuth account link). Attentively owns the customer and billing relationship.

**Voice**
- **Neutral and professional**, like a polite receptionist. Name and voice are chosen per user (onboarding: later phase). The agent always admits it's an AI if asked.

**Who pays for what: users never need an API key**
- Users reach Attentively through their normal **ChatGPT, Claude or other assistant subscription**. The assistant's own research and web/maps search **find the businesses**, under the user's subscription. **Attentively never searches for vendors.**
- Attentively uses **Google Places only after the user agrees to use Attentively**, and only to **verify** the businesses the assistant found (`verify_vendors`):
  - It drops businesses Google lists as **permanently or temporarily closed**. Assistants often still recommend them.
  - It corrects out-of-date phone numbers, gets opening hours, and flags names Google can't match.
- Verifications are cached for 14 days, and lookups are capped per user per day to control cost. A shop that closes after approval is still skipped before it's dialled.
- Attentively's own keys (Places, voice, Claude transcript extraction, email) are Attentively's running costs, covered by the Attentively subscription.

**First user**
- **The founding team** runs real inquiries for themselves first.

**Assistant number is hidden from the user too**
- The user is **never shown** their assistant number. It exists only for vendors to call back and text. When the user's own phone calls it, it gets the normal receptionist flow. Users reach Attentively through ChatGPT, email and the board link.

**Written replies: every assistant gets an email address and SMS**
- Each user's assistant also gets an **email address** (e.g. `a-7f3k@assist.attentively…`), and its number **accepts SMS**.
- If a vendor asks "can you email or text me the details?", the AI gives the assistant's address or number. Inbound emails and texts are matched to the vendor and run (by sender, then by thread or reference), parsed into observations, and added to the board, following the same late-info and Resolved rules as callbacks.

**Kolaboreyt: one board, one item per request, one subitem per vendor** (updated v2.0 from the API docs)
- **Layout:** a single **"Attentively: Quotes"** board in the configured workspace.
  - **Each request is an item:** Status (Awaiting approval, Calling, Needs you, Paused, Complete, **Resolved**), Best price, Best vendor, Location, Report link, Updated.
  - **Each vendor is a subitem:** Call status, Phone, Price, Negotiated, Alternative, Promo, Earliest, Valid until, Contact, Summary.
  - **Each call's summary and transcript** is a comment on the vendor's subitem.
- **Why one board, not one per run:** boards count against the account quota, and the Platform API can't create groups.
- **Resolved:** setting Status to Resolved in Kolaboreyt resolves the run. It's polled every `RESOLVED_POLL_SECONDS`, because the API has no webhooks.
- **Share links:** Kolaboreyt's API has none, so emails link to Attentively's own board page, which can answer *Needs you* and press Resolved. The Kolaboreyt item carries the same link.
- **Sync is idempotent** via `board_refs`: only changed cells are written, and restarts never duplicate rows or comments. Board failures never block calls.

**Shared vendor data: opt-in, anonymised, dated**
- A user's observations feed the shared vendor memory **only if they opt in**. They are stored with **no link to who asked**, and **always carry the date observed**.
- Every observation's weight decays with age: a price or stock level older than a category-specific window (e.g. 14 days for tyre prices) is shown as "last seen" context, never as a current quote, and is never used as negotiation leverage.

**Transcripts only, no audio kept**
- Calls are **transcribed but not recorded**. No audio is kept by Attentively, Twilio or ElevenLabs. Recording and audio retention must be switched off at every provider, and Phase 0 has to verify this. The transcript plus the extracted fields are the evidence. (This overrides the PRD's "audio reference".) Whether the opening line says the call is transcribed is a flag (`TRANSCRIPTION_NOTICE`), pending legal advice.

**Needs you with no reply**
- If the user hasn't answered within **~2 business hours**, Attentively **skips the question and continues** with the remaining vendors on the current brief. The unanswered question and its vendor are listed in the report.

**Alternatives offered by vendors**
- When a vendor offers a substitute ("no Michelin, but Hankook for $130"), the AI **always records it** as a separate option on the board, clearly labelled **Alternative**. The report ranks alternatives apart from exact matches.

**User-added vendors**
- The user can add vendors by name or phone number ("also call Dave's Tyres"). Attentively verifies each one (hours, category) and adds it to the plan, marked **user-added**.

---

## 2. Autonomous invocation (the key new work)

In ChatGPT, the model decides whether to call a tool from the tool's **name, description, input schema and annotations**. Making Attentively fire at the right moments and stay quiet otherwise is a design and testing task in its own right.

### 2.1 Split "should we use Attentively?" from "spend money"

Autonomous invocation is only safe if the first call is free and harmless. So:

- **`check_local_inquiry`**: read-only (`readOnlyHint: true`), no side effects, no auth required. The model can call it whenever it *suspects* a fit. It returns:
  - `fit`: `strong | possible | poor`, with a reason
  - `category` and the category's answer schema (for tyres: size, load/speed index, brand tier, fitted price, stock, lead time, promo, warranty, validity)
  - `missing_fields`: what must be clarified before planning
  - `coverage`: whether Attentively operates in the location (Gold Coast only at launch)
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
│  Model  ──tools──►  Attentively MCP server   │
│  Widget iframe (plan / board / results) │──► Attentively API (same backend)
└─────────────────────────────────────────┘
                     │
        ┌────────────┴─────────────────────────────────────────┐
        │                 Attentively core (host-independent)       │
        │  Run service ─ Orchestrator (durable workflow)       │
        │  Vendor service (canonical IDs, DNC, hours, memory)  │
        │  Extraction/checkpoint LLM                           │
        │  Approval + audit log (append-only)                  │
        │  Notification service (email)                        │
        │  Inbound assistant (per-user numbers, caller lookup) │
        │  Minutes ledger (all call time, per subscriber)      │
        │  Board sync (Kolaboreyt, best-effort)                │
        └────────────┬─────────────────────────────────────────┘
          Telephony interface │ Voice-agent interface │ Places interface
             (Twilio)         │ (ElevenLabs)          │ (Google Places)
```

Key choices:

- **One MCP server, host adapters as config.** The core tool contract carries no ChatGPT-specific fields. ChatGPT-only extras (widget template references, `_meta`) are added in a thin adapter layer.
- **Durable orchestrator.** Use Temporal, Inngest, or a Postgres-backed job queue. One workflow per run, one activity per call. This gives restart survival, webhook replay safety and sequential execution without inventing them. Pick whichever the team knows. The requirement is durability plus exactly-once dialing.
- **Idempotent dialing.** Each dial is keyed by `(run_id, vendor_id, attempt_no, brief_version)`. The telephony adapter refuses a second dial with the same key.
- **Postgres is the system of record.** The existing board tool is a projection, synced asynchronously. A board failure never blocks or loses a call (PRD §14).
- **Server-side vendor verification, not search.** The user's assistant finds vendors with its own search. Attentively re-checks each one with Google Places before it goes in a plan: business status (closed?), phone, hours and address. Model search results are the most likely place for a closed shop or a wrong number to slip in.
- **Widgets read Attentively directly.** The board widget polls `get_run` (or subscribes) through the Apps SDK widget bridge, so progress updates without the model taking a turn.

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
| `verify_vendors` | Google lookups (cached) | required | Called only after the user agrees to use Attentively. Takes the businesses the assistant found with its own search, drops closed or unknown ones, corrects phone numbers, adds hours and vendor-memory hints. The model then shows the callable ones, recommends some, and asks how many to call. |
| `get_run` | none | required | Full state: vendor items, observations with evidence, open checkpoints, current recommendation inputs. Renders the **Board** or **Results** widget. |
| `answer_checkpoint` | new brief version | required | Records the user's answer and resumes the run. A material scope change (budget, cap, identity disclosure) returns `needs_reapproval` instead. |
| `request_action` | prepares an action | required | Round-2 negotiation call-backs, re-run unanswered vendors, CSV/PDF export. Any action that places calls needs its own approval token. (Bookings and holds are out of MVP scope.) |
| `resolve_run` | stops follow-ups | required | Marks the run Resolved: no more emails or rounds, and late callbacks are logged quietly. |
| `list_runs` | none | required | History. |
| `stop_run` | stops | required | Immediate stop. Always available, no token needed. |

Replaced from the PRD: `place_call`, `get_call`, `wait_for_call` and `save_result` become orchestrator internals (change #3). `approve_run` becomes a **widget-only action**, not a model tool. `vendor_memory` is folded into `check_local_inquiry` and `plan_run`.

**How approval works (as built):** `plan_run` returns a signed **approval link** to a Attentively page showing the full plan. The user presses *Approve* there, and that press both records `approval{user_id, plan_version, method, time}` and starts the run. No model-facing tool can approve or start calls. The runner also re-checks, before every dial, that the vendor's plan version has an approval. A stale link (the plan changed since) is rejected. In Phase 2 the ChatGPT Plan-card widget links to, or embeds, the same approval action.

---

## 5. Async UX in ChatGPT (the hard part)

| Moment | Where the user sees it |
|---|---|
| Plan | Plan card widget inline in the chat |
| Calls in progress | Board widget (live-polls Attentively). The user can leave. |
| **Needs you** | Email containing the exact question + a link to the run's **Kolaboreyt board**. The answer can come from the board, the widget, or by telling ChatGPT. |
| Done | Email + Kolaboreyt board link. Back in ChatGPT, "how did it go?" → `get_run` → Results card. |
| Vendor callback | The vendor calls the user's **dedicated assistant number**. The inbound agent looks up the caller in the database, loads the earlier call's notes and continues the conversation. New info goes on the board and an updated report is emailed, unless the run is Resolved. (Reuses the existing inbound Twilio/ElevenLabs stack.) |
| Out of minutes | Run pauses before the next call. Email: top up, or get the report now. |

The **Kolaboreyt board** does the job of the standalone run page. Users can follow and answer a run there without ChatGPT, which is also the hedge against marketplace risk. Kolaboreyt is the team's existing monday.com-style board tool, built by a friend of the team. API access and integration instructions are still to come (§9).

The user confirms their email for notifications on the Plan card, before approving.

---

## 6. Delivery phases

Durations assume 2–3 engineers. Treat them as sizing, not commitments.

### Phase 0: Audit and spikes (1–2 weeks)
- Audit the existing inbound Twilio + ElevenLabs code: can it do **outbound** with a **per-call prompt override** and a **structured data-collection schema**? Record reuse, modify or rebuild for each component.
- Spike a ChatGPT dev-mode app: a hello-world MCP tool, a widget, OAuth account linking, and a widget → backend call (to validate the approval-token flow in §4).
- Spike the Kolaboreyt API (once the key and instructions arrive): create a board per run, adaptive columns, item updates, per-run links for emails, and a Resolved status or button that can reach Attentively (webhook or polling).
- Spike assistant inboxes: per-user inbound email address and SMS on the number, matched to vendor and run.
- Verify that recording and audio retention can be switched off at Twilio and ElevenLabs while live transcripts are kept.
- Spike per-user numbers: buy and configure a Twilio number by API, route its inbound calls to the voice agent, and look up the caller before the agent speaks (ElevenLabs conversation-initiation webhook or equivalent).
- Legal: Queensland recording position, AI-disclosure script, whether B2B inquiry calls fall outside telemarketing/DNC rules, and OpenAI app policy fit (see R1).
- **Exit:** signed ADR, one outbound test call to a team phone with an overridden prompt and structured extraction, one widget rendering in ChatGPT dev mode.

### Phase 1: Core and first real run (3–4 weeks)
- Postgres schema (Run, PlanVersion, Approval, BriefVersion, Vendor, Call, Observation, Checkpoint, AuditEvent).
- Orchestrator: sequential loop, business-hours gate with queue-until-open, cap, idempotent dial, extraction, brief versioning, *Needs you* pause/resume, and a negotiation step (own price first, then real competing quotes).
- Inbound assistant: each team member's dedicated number, caller lookup, context load, callback records on the board.
- Minutes ledger (all call time) and pause-when-empty, even while the pilot is free, so metering is proven before billing.
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

### Phase 2b: Self-serve onboarding (later)
- Users choose their voice agent's **name and voice** and enter their first name, then connect their account. This calls the same `onboardUser()` the CLI uses today.

### Phase 3: Private pilot (3–4 weeks)
- Invited testers on managed company keys, no charging. Human review of recommendations before they're shown, if §9 decides that.
- Round-2 negotiation call-backs with separate approval. Resolved button everywhere.
- Instrumentation: cost per usable quote, vendor answer and decline rates, time-to-recommendation.
- **Exit:** testers complete runs without developer intervention, and usefulness is ≥4/5.

### Phase 4: Public listing and billing
- Attentively sign-up site: subscription plans with included minutes (Stripe), top-ups, automatic assistant-number setup.
- App directory submission (privacy policy, safety review, tool annotations accurate), support tooling, formal legal sign-off, retention and deletion controls.

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
  /inbound-agent     assistant-number call handling + caller lookup
  /account-site      sign-up, subscription, number setup (Phase 4)
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
| R1 | **Some categories may break a host's listing policy** (weapons, for example). Attentively itself doesn't restrict categories, but a marketplace can reject or pull an app over them. | Keep one per-host exclusion list in config. Check OpenAI's current app policy in Phase 0. Leave excluded categories out of that host's tool descriptions. Other hosts or the Kolaboreyt entry point can still serve them if their policies allow. |
| R2 | The model over-triggers (annoying) or under-triggers (invisible product) | Eval set (§2.3) gates releases. A read-only entry tool makes over-triggering cheap and harmless. |
| R3 | The user never comes back to the chat | Email + Kolaboreyt board (§5). Results are never locked inside ChatGPT. |
| R4 | The model recommends closed businesses, or fabricates or garbles phone numbers | `verify_vendors` checks every vendor against Google (business status, phone, hours) before planning, and the runner re-checks status before dialling (§3). |
| R5 | The model asserts approval without the user | Approval token only from a UI event (§4). An audit test in CI tries `start_run` without a token. |
| R6 | ChatGPT platform or policy change | Core is host-independent. Claude/Grok adapters and the Kolaboreyt board are the fallback distribution. |
| R8 | Negotiation misstates a competitor's quote (legal and trust risk) | The AI may only cite observations from this run, passed to it as exact structured values with source. A transcript check after each call flags any cited figure that doesn't match. |
| R9 | Per-user numbers get flagged as spam, or cost grows with inactive users | Register the business caller ID (CNAM/branded calling where available). Release numbers after long inactivity, with notice. Watch answer rates per number. |
| R10 | Dedicated-number callbacks mix up two runs with the same vendor | Lookup returns every open run with that vendor. The agent asks which item the call is about when there is more than one. |
| R7 | Tyre spec misread from the photo | The spec is always echoed on the Plan card for confirmation. Load/speed index is a required confirmed field. |

The PRD's other risks (vendor rejection, extraction errors, recording law, cost) stand as written.

---

## 9. Decisions

**Resolved**
- ✅ **ChatGPT first.**
- ✅ **Number of calls:** the user chooses for each run. The AI lists every vendor it found, recommends the ones it would definitely call (with phone numbers and reasons), and asks how many to call (§2.4). A config safety ceiling still applies.
- ✅ **Notifications:** email, linking to the run's Kolaboreyt board.
- ✅ **Categories:** not restricted by product choice. Tyres, guns and tools were examples. Exclusions come only from host policy (R1).
- ✅ Assistant number per user, AI answers all inbound, negotiation rules, report plus next step, queue-until-open, Resolved button, minutes billing, sign-up on Attentively's site, voice, first user: see §1.1.
- ✅ **Kolaboreyt** is the team's existing monday.com-style board tool. Attentively owns the workspace and users get share links.
- ✅ Opt-in anonymised dated data sharing, transcripts only, hidden assistant number, assistant email and SMS, skip Needs-you after ~2 business hours, record alternatives, user-added vendors: see §1.1.

**Still open**
1. **Kolaboreyt API:** waiting on the key and integration instructions. Put the key in `KOLABOREYT_API_KEY` as an environment secret, not in chat or the repo. Check: per-run board links, custom columns, and Resolved status sync.
2. **Approval mechanism:** widget-issued token (preferred) or host write-confirmation. Phase 0 spike decides.
3. **Orchestrator tech:** Temporal vs Inngest vs a Postgres queue.
4. **Vendor discovery source:** Google Places vs an alternative, and its licensing for storing vendor data in vendor memory.
5. **Email provider** (e.g. Postmark, SES, Resend).
6. **Safety ceiling value** for calls per run (config, e.g. 10–15).
7. **Plan pricing:** minutes per tier, price, top-up price, and whether the assistant number is included.
8. The remaining PRD §21 decisions (retention period, human review of recommendations).

---

## 10. Next concrete steps (this week)

1. Get the Kolaboreyt API key and instructions (key goes into env secrets).
2. Give engineering access to the existing inbound Twilio/ElevenLabs code and the board-tool API docs.
3. Start the Phase 0 spikes in parallel: outbound call with prompt override, ChatGPT dev-mode widget + OAuth, board API.
4. Draft the invocation eval prompts. Anyone on the team can write these, and it's the fastest way to sharpen *when* Attentively should appear.
5. Book the legal consult (Queensland recording, AI disclosure, DNC applicability, platform policy for restricted goods).
