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
  It ships as a deterministic score (overdue first, then unstarted, then in-progress, then ready),
  because the current schema has neither promised time nor per-item prep duration; it makes no LLM call
  and consumes no AI credit.
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
4. **The kitchen "next tickets" feature is deterministic in this wave.** The current schema records
   status and `sent_to_kitchen_at`, but no promised-ready time or prep-duration data. The shared scorer
   therefore ranks overdue tickets first, then `sent`, `preparing`, and `ready`, with oldest-first ties;
   it makes no provider call and consumes no AI credits. Future schedule/prep metadata can extend this
   transparent score without retroactively changing the access boundary.
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
2. If a future schema gains promised-ready times, prep durations, or item dependencies, which of those
   inputs should refine the deterministic kitchen score without making it opaque?
3. The platform support agent is unmetered and uses the existing platform-owned provider connection.
   Does operations need a separate platform cost budget or rate limit before its volume grows?
4. Timing for Wave 5's real channel integrations (WhatsApp/Telegram/voice) — a fast-follow phase right
   after this one, or deferred indefinitely until there's demand? Not decided here.

## Status: Wave 1 implemented (partial); Wave 2 complete; Wave 3 implemented — Waves 4–5 planned

Phase 18's metering is in place, so Wave 1 (read-only tools) has shipped, per this phase's own
sequencing decision. 16 of the 20 tools listed under Wave 1 are implemented as `runReadTool` cases
in `src/lib/ai-tools.ts`, each backed by an existing reporting view or service function (never a new
mutation path), exposed via `toolDefinitions("dashboard")` in `src/lib/ai.ts`, and named in
`buildSystemPrompt`'s dashboard-mode block so the model knows they exist:

`get_menu_performance`, `get_void_pattern`, `get_stock_valuation`, `get_supplier_performance`,
`get_reservation_conflicts`, `get_table_turnover_rate`, `get_courier_performance`,
`get_customer_profile`, `get_at_risk_customers`, `get_ar_aging`, `get_ap_upcoming`,
`get_unreconciled_bank_lines`, `get_payroll_summary`, `get_vat_liability`, `get_branch_comparison`,
`forecast_demand`.

Four tools from the original Wave 1 list are **not** implemented — not a wiring gap, but a genuine
data-model gap discovered while implementing the rest:

- **`get_expiring_batches`** — no expiry/shelf-life column exists anywhere in the inventory schema
  (`inventory_lots` tracks `received_at`, never an expiry date).
- **`get_delivery_zone_heatmap`** — `deliveries.address` is free text; there's no zone/geo data model
  to bucket by.
- **`get_shift_coverage_gaps`** and **`get_overtime_summary`** — there's no staff shift/clock-in
  entity in the schema at all. Phase 8's own doc already noted this (`v_shift_reconciliation` is
  explicitly a proxy: "the set of orders one cashier closed on one business day," not a real shift).
  Wave 2's `staff.shift.create` action implies this phase eventually needs to *build* a shifts entity
  — at which point these two read tools become straightforward. Building that entity as a byproduct
  of a read-only tool wasn't judged in scope here.

Two implemented tools made a documented approximation rather than inventing new schema:

- **`get_void_pattern`** attributes voids to the order's opener (`orders.opened_by`), not a per-line
  "who voided this" column (doesn't exist) — the tool's own returned data carries a `note` field
  saying so, not just the system prompt (same "don't rely on the model to hedge" principle as
  Decision 6 below).
- **`get_ap_upcoming`** has no due-date to sort by (`purchases` never gained a due date/payment-terms
  column), so it returns open bills oldest-first as a payment-priority proxy, with the same kind of
  `note` field explaining why.

Wave 2 (the `propose_action` catalogue expansion) is **complete for its documented existing-endpoint
scope**: all 13 actions backed by a real, already role-guarded endpoint are `ACTION_CATALOG` entries in `src/lib/ai.ts`, each mapping
to an already role-guarded, real endpoint — no new mutation architecture, exactly like the six
setup-wizard actions before them:

`menu.item.priceUpdate`, `menu.item.disable` (both → `PATCH /api/menu/items/{id}`),
`order.discount.apply` (→ `PATCH /api/orders/{id}`), `inventory.reorder.draftPO`
(→ `POST /api/inventory/purchases`, status `draft`), `inventory.adjustment.propose`
(→ `POST /api/inventory/stock-counts`), `reservation.create` (→ `POST /api/reservations`),
`reservation.reschedule` (→ `PATCH /api/reservations/{id}`), `table.merge` (→
`PATCH /api/table-sessions/{id}`, `action: "merge"`), `table.split` (→
`POST /api/table-sessions/{id}/split`), `courier.assign` (→ `PATCH /api/deliveries/{id}`,
`action: "assign"`), `customer.note.add` (→ `PUT /api/customers/{id}`), `journal.manual.propose`
(→ `POST /api/ledger/entries/drafts`, feeding Phase 16's existing approval queue, never posting
directly), and `expense.categorize` (→ `POST /api/ledger/expenses`).

Some of these endpoints only accept `PATCH`/`PUT`, not `POST` like every setup-wizard action — so
`ActionMeta.method` widened to `"POST" | "PATCH" | "PUT"` (still exactly one already-guarded
endpoint per action, just not exclusively POST anymore). And several act on one specific existing
resource (a menu item, an order, a reservation, …), which the setup-wizard actions never needed to
address — so `ActionMeta.endpoint` may now contain a `{paramName}` placeholder (e.g.
`/api/orders/{orderId}`), resolved from the model's own proposed payload by the new
`resolveActionEndpoint` (pure, unit-tested in `ai.test.ts`) before the client's "Apply" button
fetches it; a missing placeholder value refuses the fetch instead of hitting a confusing 404.

The six original Wave 2 ideas below are explicitly deferred schema work, not missing Wave 2 wiring;
none has an existing endpoint or data model to map safely, matching Wave 1's own precedent for
`get_expiring_batches`/`get_delivery_zone_heatmap`/shift tools:

- **`delivery.eta.adjust`** — `deliveries` has no ETA/estimated-time column at all (only
  `dispatched_at`/`delivered_at`, set once each actually happens).
- **`customer.creditLimit.propose`** — `customers` has no credit-limit column; AR exposure is only
  ever computed from unpaid invoices (`get_ar_aging`), never capped against a stored limit.
- **`staff.shift.create`** and **`staff.shift.swap.propose`** — same gap Wave 1 already found: no
  staff shift/clock-in entity exists in the schema at all.
- **`discount.create`** and **`promo.create`** — there's no reusable named-discount or promo-code
  entity; the only discount mechanism today is the per-order `discount` field
  `order.discount.apply` already covers.

Building any of these six needs a schema decision first (a new column or a new entity), which
wasn't judged in scope for widening an existing catalogue.

### Wave 3 implementation

- **Cashier/waiter assistant:** `/api/ai/chat` now accepts the narrow `floor` mode only after
  `requireFloorAssistant()` verifies a live cashier/waiter membership and `menu.view` permission.
  It receives an active-location scope and only exposes `get_menu_item_details` and
  `get_bill_split_preview`. Ingredient responses return recorded recipe ingredients and explicitly
  state that structured allergen data is absent; bill splitting is an equal-share preview only. This
  mode has no `propose_action` definition, and the agent loop rejects even a hand-crafted action
  tool call instead of treating it as executable.

- **Kitchen next-ticket ranking:** `src/lib/kitchen-priority.ts` is a pure, shared deterministic
  scorer used by the kitchen queue route and KDS. It ranks overdue tickets first, then unstarted
  (`sent`), in-progress (`preparing`), and ready tickets, with oldest-first ties. The KDS exposes
  the next ticket and visible priority labels. No LLM/provider call is involved, so this slice does
  not debit a business's AI credits.

- **Platform support agent:** `POST /api/platform/ai/support` is wrapped in
  `withPlatformScope` and requires `requirePlatformCapability("ai.read")`. It has a separate
  `platform` mode, prompt, and tool executor: only client-version compliance and backup-health
  summaries are returned. It cannot use tenant read tools or `propose_action`, and its unmetered
  calls are recorded in the platform audit log. The platform AI page exposes this health-only chat to
  operators who hold that read capability.

Wave 3's pure priority and agent-isolation tests cover its ordering policy, floor-mode action rejection,
and platform tool isolation. Waves 4–5 (background jobs and the broader UX layer) remain planned.
