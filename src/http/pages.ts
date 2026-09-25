import type { Plan } from "../core/types.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#0f766e;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--accent:#2dd4bf;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:24px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.tag{font-size:.8rem;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
button{background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}textarea{width:100%;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.warn{color:var(--warn)}ul{padding-left:20px}details summary{cursor:pointer;color:var(--muted)}
</style></head><body><main>${body}</main></body></html>`;
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}

export function approvalPage(input: {
  plan: Plan;
  requestText: string;
  questions: string[];
  minutesRemaining: number;
  alreadyApproved: boolean;
  stale: boolean;
  actionUrl: string;
}): string {
  const p = input.plan;
  const selected = p.vendors.filter((v) => v.selected);
  const skipped = p.vendors.filter((v) => !v.selected);
  const body = `
<h1>Approve calls</h1>
<p class="muted">${esc(input.requestText)}</p>
<div class="card">
  <div class="row"><strong>Location</strong><span>${esc(p.location.text)}</span></div>
  <div class="row"><strong>Looking for</strong><span>${esc(p.need.quantity ? `${p.need.quantity} x ` : "")}${esc(p.need.item)} ${esc(Object.values(p.need.specs).join(" "))}</span></div>
  ${p.need.required_by ? `<div class="row"><strong>Needed by</strong><span>${esc(p.need.required_by)}</span></div>` : ""}
  <div class="row"><strong>Calls</strong><span>${selected.length} vendor${selected.length === 1 ? "" : "s"}, one at a time, in business hours</span></div>
  <div class="row"><strong>Estimated minutes</strong><span>~${p.estimated_minutes} (you have ${input.minutesRemaining})</span></div>
</div>
${p.estimated_minutes > input.minutesRemaining ? `<p class="warn">This may use more minutes than you have left. If they run out, calling pauses and we'll email you.</p>` : ""}
<h2>Who we'll call${p.round > 1 ? ` (round ${p.round})` : ""}</h2>
${selected.map((v) => `<div class="card"><div class="row"><strong>${esc(v.name)}</strong><span class="muted">${esc(v.phone)}</span></div>${v.recommended ? `<span class="tag">recommended</span> ` : ""}${v.source === "user_added" ? `<span class="tag">added by you</span> ` : ""}${v.reason ? `<span class="muted">${esc(v.reason)}</span>` : ""}</div>`).join("")}
${skipped.length ? `<details><summary>Found but not calling (${skipped.length})</summary><ul>${skipped.map((v) => `<li>${esc(v.name)}</li>`).join("")}</ul></details>` : ""}
<h2>What we'll ask</h2>
<ul>${input.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
<p class="muted">${p.allow_negotiation ? "After each shop gives its own price, the assistant may mention the best real quote so far (shop name and price) to ask for a better deal." : "No negotiation."}</p>
<h2>Your privacy</h2>
<p class="muted">${esc(p.disclosure)} We gather information only: no bookings, holds or payments. The report goes to ${esc(p.notify_email)}.</p>
${
  input.stale
    ? `<p class="warn">This plan has been replaced by a newer one. Ask ChatGPT for the latest plan.</p>`
    : input.alreadyApproved
      ? `<p><strong>Approved.</strong> Calls are under way; we'll email you.</p>`
      : `<form method="post" action="${esc(input.actionUrl)}"><button type="submit">Approve and start calling</button></form>
<p class="muted">Nothing is called until you press Approve. You can stop at any time.</p>`
}`;
  return layout("Approve calls", body);
}

export interface BoardPageData {
  requestText: string;
  location: string;
  status: string;
  resolved: boolean;
  nextStep?: string;
  vendors: Array<{
    name: string;
    phone: string;
    status: string;
    offers: Array<{ kind: string; phase: string; description: string; total_price?: number; earliest_date?: string; promo?: string; valid_until?: string; evidence?: string }>;
    calls: Array<{ direction: string; summary: string | null; transcript: Array<{ role: string; text: string }> }>;
  }>;
  needsYou: Array<{ id: string; vendor: string; question: string; why: string | null }>;
  answerUrl: string;
  resolveUrl: string;
}

export function boardPage(d: BoardPageData): string {
  const statusLabel = (s: string) => s.replace(/_/g, " ");
  const body = `
<h1>${esc(d.requestText)}</h1>
<p class="muted">${esc(d.location)} · <span class="tag">${esc(d.resolved ? "resolved" : statusLabel(d.status))}</span></p>
${d.nextStep ? `<div class="card"><strong>Recommended next step</strong><p>${esc(d.nextStep)}</p></div>` : ""}
${d.needsYou
  .map(
    (n) => `<div class="card"><strong>Needs you</strong>: ${esc(n.vendor)} asked <em>${esc(n.question)}</em>
<p class="muted">${esc(n.why)}</p>
<form method="post" action="${esc(d.answerUrl)}"><input type="hidden" name="checkpoint_id" value="${esc(n.id)}">
<textarea name="answer" rows="2" required placeholder="Your answer"></textarea><p><button type="submit">Send answer</button></p></form></div>`,
  )
  .join("")}
<h2>Vendors</h2>
${d.vendors
  .map(
    (v) => `<div class="card"><div class="row"><strong>${esc(v.name)}</strong><span class="tag">${esc(statusLabel(v.status))}</span></div>
<div class="muted">${esc(v.phone)}</div>
${v.offers.length ? `<ul>${v.offers.map((o) => `<li>${o.kind === "alternative" ? "<strong>Alternative:</strong> " : ""}${esc(o.description)}: <strong>${o.total_price != null ? `$${esc(o.total_price)}` : "no price"}</strong>${o.phase !== "initial" ? ` <span class="tag">${esc(o.phase)}</span>` : ""}${o.earliest_date ? `, from ${esc(o.earliest_date)}` : ""}${o.promo ? `. Promo: ${esc(o.promo)}` : ""}${o.valid_until ? `. Valid until ${esc(o.valid_until)}` : ""}${o.evidence ? `<br><span class="muted">"${esc(o.evidence)}"</span>` : ""}</li>`).join("")}</ul>` : ""}
${v.calls
  .map(
    (c) => `<details><summary>${esc(c.direction)} call${c.summary ? `: ${esc(c.summary)}` : ""}</summary>${c.transcript
      .map((t) => `<p><strong>${t.role === "agent" ? "Assistant" : "Vendor"}:</strong> ${esc(t.text)}</p>`)
      .join("")}</details>`,
  )
  .join("")}
</div>`,
  )
  .join("")}
${d.resolved ? "" : `<form method="post" action="${esc(d.resolveUrl)}"><p><button class="secondary" type="submit">Resolved: stop following this up</button></p></form>`}
<p class="muted">Transcripts only; no audio is recorded.</p>`;
  return layout("Attentively board", body);
}
