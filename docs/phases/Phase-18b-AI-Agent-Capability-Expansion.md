# Phase 18b — AI Agent Capability Expansion

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 18 (AI Platform Administration & Credit Billing — every tool/action added here
is metered by it), and the domain phases whose data these tools read/write: Phase 3 (Reservations/
Floor), Phase 4 (Waiter/Kitchen), Phase 6 (Inventory), Phase 8 (Reporting), Phase 9/14 (Multi-Location
Rollup), Phase 11 (Delivery), Phase 13 (Teams/Permissions), Phase 16 (Accounting Suite), and the
(also undocumented, like the AI baseline itself) customers directory.
**Goal:** Grow the assistant from a setup-wizard-and-reports co-pilot into an operations assistant
that covers every module in the product — more read tools, a wider `propose_action` catalogue, and
role-scoped variants beyond owner/manager — without changing the confirm-before-apply architecture
that makes it safe today.

---

## Context

Phase 18 makes the assistant a metered, platform-run service. This phase is the other half: it
doesn't touch billing/administration at all — it's purely about what the agent can read and do once
it's turned on. Today that's narrow: `get_setup_state`, `list_reports`, `run_report`, and a
`propose_action` allowlist limited to setup-wizard fields (business info, chart of accounts, costing,
tax, menu category/item). Every module below already has real API endpoints and RLS-scoped data; this
phase wires the same read-tool / propose-and-confirm pattern into each of them rather than inventing a
new mechanism per module.

## Scope — shipped in waves, not all at once

Ordered deliberately: cheapest and lowest-risk first, since every tool/action added here also adds
tokens and tool-rounds that Phase 18 meters as credits — shipping in waves keeps each slice reviewable
and lets the credit-pricing assumptions get validated against real usage before the next wave lands.

### Wave 1 — read-only tools (zero mutation risk, ships first)
- **Orders & menu:** `get_menu_performance` (best/worst sellers, never-ordered items), `get_void_pattern`
  (void clustering by cashier/item/time).
- **Inventory:** `get_stock_valuation`, `get_expiring_batches`, `get_supplier_performance`.
- **Reservations & floor:** `get_reservation_conflicts`, `get_table_turnover_rate`.
- **Delivery:** `get_courier_performance`, `get_delivery_zone_heatmap`.
- **Customers:** `get_customer_profile`, `get_at_risk_customers` (lapsed frequent customers).
- **Accounting suite:** `get_ar_aging`, `get_ap_upcoming`, `get_unreconciled_bank_lines`,
  `get_payroll_summary`, `get_vat_liability`.
- **Staff:** `get_shift_coverage_gaps`, `get_overtime_summary`.
- **Cross-branch:** `get_branch_comparison` (sales/margin/labor-cost across a business's own branches).
- **Forecasting:** `forecast_demand` — explicitly an estimate, not a projection a small-business owner
  should take literally; the tool's own returned data carries the "این یک تخمین است" framing so it
  can't be dropped by an inconsistent system prompt (see Decision 6).

### Wave 2 — widen the `propose_action` catalogue (still human-confirmed, same UX)
- **Menu/orders:** `menu.item.priceUpdate`, `menu.item.disable`, `order.discount.apply`.
- **Inventory:** `inventory.reorder.draftPO`, `inventory.adjustment.propose`.
- **Reservations/floor:** `reservation.create`, `reservation.reschedule`, `table.merge`, `table.split`.
- **Delivery:** `courier.assign`, `delivery.eta.adjust`.
- **Customers:** `customer.note.add`, `customer.creditLimit.propose`.
- **Accounting:** `journal.manual.propose` (drafts into Phase 16's existing manual-journal *approval
  workflow* — the agent feeds that workflow, it never bypasses it), `expense.categorize`.
- **Staff:** `staff.shift.create`, `staff.shift.swap.propose`.
- **Discounts/promos:** `discount.create`, `promo.create`.

### Wave 3 — role-scoped agent variants (new guards, not a reuse of `requireManager`)
- **Cashier/waiter assistant** — menu Q&A, allergen/ingredient lookup, bill-splitting help. Read-only
  against menu/order/table data; deliberately ships with **no** `propose_action` tool at all — too
  much blast radius for that role.
- **Kitchen "next tickets" ranking** — not a chat surface; a ranked queue fed by the same tool layer.
  Whether this needs an LLM call at all versus a deterministic scoring function (promised time, item
  prep time) is an open question below, not decided here.
- **Platform-side support agent** — scoped to the platform team via `requirePlatformCapability`, a
  fully separate realm from tenant `propose_action` (per this repo's existing rule: anything
  supervising across businesses belongs under `/platform`, not a per-business dashboard). Answers
  things like "which businesses are on an old app version" or "whose backup failed last night."

### Wave 4 — proactive/background jobs (agent as scheduled job, not just reactive chat)
- Daily/weekly Persian-language digest; anomaly flags (void/discount spikes, negative-margin items);
  low-stock/reorder nudges; end-of-shift till reconciliation summary; VAT-filing-due and
  unreconciled-bank-line reminders; payroll-run reminder; branch-divergence flag; delivery-running-late
  flag; reservation no-show risk flag; a drafted (never auto-sent) customer debt-follow-up message.
- Runs outside a request like every other background job in this repo: enumerate businesses under a
  bypass, then wrap each business's own work in `withTenant(businessId, …)`.

### Wave 5 — UX/interface layer on top of the above
- "Explain this number" button next to a chart/report tile (pre-fills chat context).
- Suggested-prompt chips on open; streaming responses instead of the current blocking POST.
- An audit trail of every applied `propose_action` (who prompted it, what was proposed/applied) — more
  important once the catalogue is this much bigger than setup-only.
- An estimated-credit-cost preview before a multi-tool-round query runs, so a business isn't
  surprised by its Phase 18 balance draining on one expensive question.
- Channel front-ends (WhatsApp/Telegram bot, voice input for cashier/waiter) reusing the same
  `runAgentTurn` core — treated as a later, separate integration, not part of this phase (see Out of
  scope).

## Out of scope

- Any real messaging-gateway integration (WhatsApp Business API, Telegram bot tokens, SMS) — Wave 5
  lists the idea, but wiring an actual channel is its own phase's worth of infra/vendor decisions.
- Auto-sending any customer-facing message. The debt-follow-up idea (Wave 4) is draft-only — the agent
  proposes text, a human sends it through their own channel. This extends the existing
  confirm-before-apply philosophy from data mutations to communications, not just database writes.
- Cross-tenant benchmarking ("how do I compare to similar businesses") — would need real anonymization
  and consent work across tenants, a materially bigger and separate privacy question.
- Any change to Phase 18's billing/administration model — this phase only adds tools/actions that
  Phase 18 meters, it doesn't touch how metering itself works.

## Exit criteria

- Every Wave 1 tool is implemented the same way `get_setup_state`/`run_report` are today: a pure
  `runReadTool` case, tenant-scoped by the caller's own session, covered by a unit test the way
  `ai-tools.ts`'s existing tools are.
- Every Wave 2 action is a new `ACTION_CATALOG` entry mapping to an already role-guarded existing
  endpoint — no new mutation architecture, no direct-write path that skips human confirmation.
- The cashier/waiter and platform-support variants each have their own guard function (not
  `requireManager`) and their own tool list — verified that neither can reach `propose_action` (cashier/
  waiter) or a tenant's data (platform support) even by a hand-crafted request.
- Every background job in Wave 4 is proven, the same way Phase 17 proved tenant isolation, to never
  read or credit-debit a business other than the one it's currently scoped to.
- The system prompt's tool/action catalogue description (`buildSystemPrompt` in `ai.ts`) is regenerated
  to include every wave shipped so far — the model is never missing a tool it should know about.

## Decisions

1. **Waves ship independently, read-only first.** Wave 1 carries zero mutation risk and is the
   cheapest to validate against Phase 18's credit pricing; later waves build on it rather than landing
   as one large change.
2. **Wave 2 stays strictly additive to the existing `ACTION_CATALOG` shape** — every new action is
   `{ type, endpoint, method, label, payloadHint }` mapping to a real, already-guarded endpoint, exactly
   like the six setup-wizard actions today. No new proposal/confirm mechanism.
3. **Role-scoped variants get their own tool sets and guards, not a trimmed-down copy of the manager
   agent.** The cashier/waiter variant in particular ships with zero mutation tools by design — read
   access to menu/order data is useful on the floor, but a `propose_action` surface for that role is a
   bigger trust decision this phase doesn't make unilaterally.
4. **The kitchen "next tickets" feature may not need an LLM call at all** — a deterministic scoring
   function (promised time, prep time, item dependencies) could serve the same UX more cheaply and more
   predictably than a chat-style round-trip. Left open below rather than assumed.
5. **The platform support agent is a fully separate agent, not an extra mode on the tenant one.**
   Separate prompt, separate tool list, separate capability gate (`requirePlatformCapability`) — it
   never has access to `propose_action` or any single business's confirm-and-apply flow, matching how
   Phase 15's console itself is a disjoint realm from the tenant dashboard.
6. **Every forecasting/estimate tool's returned data — not just the system prompt — carries an
   explicit "this is an estimate" marker.** Given the audience (small business owners who may take a
   number literally), relying on the model to consistently hedge in its own words isn't enough; the
   tool result itself is shaped to make the caveat unavoidable.
7. **Customer-facing communication proposals are draft-only, mirroring data mutations.** `customer.note.add`
   internal notes can apply directly to the business's own records like any other confirmed action; a
   debt-follow-up *message* is different — it leaves the business's own systems and reaches a real
   person, so it's drafted for a human to review and send themselves, never auto-dispatched.

## Open questions

1. Are Wave 4's proactive/background jobs opt-in per business, or on by default once `ai_assistant` is
   enabled? These run without a human explicitly starting them, so they consume Phase 18 credits
   unattended — needs a product-owner call, not assumed here.
2. Does the kitchen "next tickets" ranking (Wave 3) need the LLM at all, or is a deterministic scoring
   function sufficient (Decision 4)? If deterministic, it may not belong in this phase's scope at all,
   since it wouldn't touch the assistant/credit system.
3. Does the platform support agent (Wave 3) run against Phase 18's same metered provider config, or a
   separate, unbilled internal one, since its cost isn't attributable to any one business? Proposed:
   separate and unmetered, but not decided here.
4. Timing for Wave 5's real channel integrations (WhatsApp/Telegram/voice) — a fast-follow phase right
   after this one, or deferred indefinitely until there's demand? Not decided here.

## Status: planned — not yet implemented

Nothing in this phase has been built. Per this repo's phase discipline and Phase 18's own precedent,
implementation should start with Wave 1 only once Phase 18's metering is actually in place — shipping
new billable tools before there's a billing system to meter them defeats the point of sequencing these
two phases the way they're numbered.
