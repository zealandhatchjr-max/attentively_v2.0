# Invocation evals

Tests **when the ChatGPT model decides to call Ringer on its own** (docs/PLAN.md §2.3).
Re-run after every change to tool names, descriptions or annotations in `src/mcp/server.ts`.

`prompts.jsonl` is the seed set (28 prompts). Grow it to ~150, weighted towards near-misses.

| expect | pass when |
|---|---|
| `call` | the model calls `check_local_inquiry` |
| `call_on_turn_2` | no call on turn 1; a call on turn 2 |
| `no_call` | no Ringer tool is called |
| `call_then_not_covered` | the model calls it, then tells the user Ringer isn't available there |
| `call_then_ask_location` | the model calls it, then confirms the location before planning |
| `no_call_or_offer_after_safety_answer` | the model answers the safety question first; offering Ringer after that is fine |

How to run (until it's automated): connect the dev server to ChatGPT developer mode, paste each
prompt into a fresh chat, and record the result in `results/<date>.csv`
(`id,called,turn,notes`). Targets: ≥90% recall on direct/implicit/image and ≤5% false positives on near-miss/online-buyable.
