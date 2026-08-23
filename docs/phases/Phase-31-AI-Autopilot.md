# Phase 31 — AI Autopilot (خلبان خودکار دستیار)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 18 (metering — every unattended turn is billed by it), Phase 18b Waves 2/4/5
(the `propose_action` catalogue, the background job runner, and the action audit trail), and Phase 16
(the manual-journal approval queue that Decision 1 protects).
**Goal:** Close the one gap between what the assistant can see and what it can do: let an owner decide
*in advance*, per category of change, which class of fix the agent may apply without a click — with
real numeric guardrails, a full audit trail, and one-click undo.

---

## Context

Phase 18b Wave 2 gave the agent thirteen real, role-guarded actions. Wave 4 gave it a scheduled brain
that already finds problems on its own — low stock, cost drift, void and discount spikes,
negative-margin items, unreconciled bank lines, no-show risk. The two never met. The agent could see
at 08:00 that three items were below reorder level and still needed an owner to open a chat window and
press a button, because **every "apply" in the product is a browser fetch carrying the signed-in
user's session cookie**, and the tick has no request, no session and no cookie. It could not act at
all — not as a policy choice, but structurally.

Autopilot is not a relaxation of the confirm loop. It is an owner deciding, once and per category,
which changes they have already confirmed. Everything outside what they turned on — and everything
over the caps they set — still lands in the same confirm-and-click flow it does today.

## The load-bearing decision

**A server-side executor per eligible action calls the same service function the route handler
calls** — never an internal HTTP loopback, never a second mutation path, always inside
`withTenant(businessId, …)` so RLS is the boundary exactly as it is in a request. Five of the seven
executors reuse a function that was already extracted; two lived inline in their routes and were
extracted (behaviour-identical) so the route and the unattended path share one implementation:

| Executor | Route it shares with | Function |
|---|---|---|
| `menuItemPatch` | `PATCH /api/menu/items/[id]` | `updateMenuItem` (`src/lib/menu-service.ts`) |
| `stockCount` | `POST /api/inventory/stock-counts` | `createStockCount` (`src/lib/stock-count-service.ts`) |
| `customerNote` | `PUT /api/customers/[id]` | `updateCustomer` (`src/lib/customers-service.ts`) |
| `expense` | `POST /api/ledger/expenses` | `recordExpense` (`src/lib/expense-service.ts`) |
| `journalDraft` | `POST /api/ledger/entries/drafts` | `createDraft` (`src/lib/manual-journal-service.ts`) |
| `orderDiscount` | `PATCH /api/orders/[id]` — **was inline** | `applyOrderDiscount` (new `src/lib/order-discount-service.ts`) |
| `draftPurchase` | `POST /api/inventory/purchases` — **was inline** | `createDraftPurchase` (new `src/lib/purchase-service.ts`) |

`resolveActiveLocation(session)` is unusable without a request, so each executor resolves the branch
**from the target row** (already tenant-bounded by RLS) rather than guessing a primary branch; a stock
count or purchase order whose lines span branches is refused (`autopilot_mixed_location`) rather than
split or misfiled.

## Scope

- `migrations/0097_ai_autopilot.sql` — `ai_autopilot_settings`, `ai_autopilot_activity_seen`, six new
  `ai_action_audit` columns and a `'reverted'` status, and a widened `ai_proactive_runs.kind`.
- `src/lib/ai-autopilot.ts` — the pure guardrails (ceilings, clamp, the decision function).
- `src/lib/ai-autopilot-executors.ts` — the seven executors and six reverters.
- `src/lib/ai-autopilot-service.ts` — settings, activity, undo, and the per-category run.
- `src/lib/ai.ts` — `autopilotCategory`/`executor`/`revertible` on `ActionMeta`, plus an `autopilot`
  agent mode whose `propose_action` enum is narrowed to the running category.
- Three routes under `/api/ai/autopilot`, two hub components, and an unseen badge on the launcher.

**Five categories:** `inventory`, `pricing`, `money`, `customer`, `waste`. **Eight of the thirteen
actions are eligible**; the six setup-wizard actions and the five live floor actions
(`reservation.*`, `table.*`, `courier.assign`) are permanently manual.

## Decisions

1. **Money-moving splits three ways, and `journal.manual.propose` is draft-creation only.** Phase 16
   built a *human* manual-journal approval queue, gated on `ledger.approve`. That is an **accounting
   control that predates and is independent of the AI confirm loop** — it exists so no single actor
   both writes and posts an entry, which is true whether a human or the agent drafted it. Autopilot
   here means the draft is created *without a chat round-trip*, into the same queue; a human still
   approves it. `ai-autopilot-executors.ts` never imports `approveDraft`, and `ai.test.ts` pins the
   action's endpoint so it cannot be quietly repointed at the approve route.
   `order.discount.apply` and `expense.categorize` have no such second approval, so under a Rial cap
   they genuinely apply unattended.

2. **Customer-facing autopilot writes internal records only; nothing is ever sent.** Phase 18b
   Decision 7 makes draft-only a *communications-safety* decision — a message leaves the business's
   systems and reaches a real person — not a symptom of the confirm loop. `customer.note.add` writes
   a note on the business's own record and reaches nobody, so it autopilots. The debt follow-up is
   unchanged: `runDebtDrafts` writes local drafts and a human sends them. The `customer` category has
   no gateway, no phone number and no send path in any code it touches, and no setting can add one.

3. **Waste is detected, never logged automatically.** A `waste` stock movement destroys stock, posts
   Debit waste-expense / Credit inventory, and requires a `waste_reason` (spoilage / prep error /
   staff meal / …) that **is not inferable from data** — the difference between spoilage and a staff
   meal is a fact only a person in the room has. The category reads waste and negative-margin data,
   raises flags, and where a real discrepancy exists may surface an `inventory.adjustment.propose` —
   judged under the *inventory* category's own switch and cap, not waste's. F&B only, guarded on
   `businesses.industry` the same way the service-reminder job is watch-only.

4. **Genuinely per-category, gated by three switches.** `features.ai_assistant` →
   `ai_proactive_settings.enabled` (the existing credit opt-in; unattended provider calls spend a
   business's own money, which is what that switch has always governed) → this category's own
   `ai_autopilot_settings.enabled`. There is no master switch: "inventory on, money off" is a
   first-class stored state. Enabling `money` additionally requires the owner's own role — a manager
   may tune its caps downward but cannot switch on unattended money movement.

5. **Undo is a property of the action, and prior state is captured at execution time.**
   `proposal_payload` holds only the value the model proposed, so on its own it can never answer
   "what was the price before". Each executor reads the prior value **inside the same transaction as
   the write** and it is persisted to `ai_action_audit.prior_state`. Two actions are marked honestly:
   `order.discount.apply` is `while_open` (the reverter refuses once the bill is settled, since
   `recomputeOrderTotals` only applies to an open order), and `expense.categorize` has **no** one-click
   undo — `reverseEntry` only accepts a `source_type` of `'manual'`, which an expense's entry is not.
   The UI offers no undo button for it. That is why `money` ships with the tightest default caps.

6. **One turn per enabled category per business per local day.** `runAgentTurn` returns at most one
   proposal per turn, and this phase does not change that contract; the category becomes the unit of
   work instead, claimed through the existing `ai_proactive_runs` UNIQUE
   `(business_id, kind, period_key)` with `period_key = '<date>:<category>'`. Autopilot mode is
   **zero-tool** like the proactive digest: the service collects a bounded, category-scoped fact set
   from existing read tools and hands it to the model in the prompt. That keeps an unattended run to a
   single provider round, and means the model can only act on facts this codebase gathered. A category
   with nothing worth acting on never reaches the provider and spends no credit at all.

7. **Over-cap means "hand it to a human", never "drop it" and never "do it anyway".** A deferred
   proposal is still written to the audit trail with `status='proposed'` and a `deferred_reason`, and
   is clickable in the hub through the *identical* browser-fetch path a chat proposal uses (shared via
   `src/components/ai/apply-proposal.ts`, extracted so the two can never diverge). Owner-set caps are
   clamped to a server ceiling on write **and again on read**, so lowering a ceiling in a later release
   narrows every stored setting with no data migration. The values the caps are measured against —
   current price, order subtotal, document value — are read from the database, never taken from the
   model's own payload, so a proposal cannot talk its way under a cap.

8. **Floor mode is untouched.** Cashier/waiter/kitchen keep Wave 3's narrow read-only assistant with
   no `propose_action` tool at all. No autopilot code path, badge or route is reachable from
   `mode === "floor"`; every `/api/ai/autopilot/*` route is `requireManager()`-guarded.

## Where each piece is

| Concern | File |
|---|---|
| Schema, RLS, ceilings as CHECKs | `migrations/0097_ai_autopilot.sql` |
| Pure guardrails | `src/lib/ai-autopilot.ts` (+ `ai-autopilot.test.ts`) |
| Executors and reverters | `src/lib/ai-autopilot-executors.ts` |
| Settings, activity, undo, the run | `src/lib/ai-autopilot-service.ts` (+ `ai-autopilot-service.test.ts`) |
| Extractions | `src/lib/order-discount-service.ts`, `src/lib/purchase-service.ts` |
| Catalogue tagging + autopilot prompt/tools | `src/lib/ai.ts` (+ `ai.test.ts`) |
| API | `src/app/api/ai/autopilot/{route,activity/route,revert/route}.ts` |
| UI | `src/app/dashboard/ai/ai-autopilot-{settings,activity}.tsx`, `src/components/ai/{ai-assistant,apply-proposal}.ts(x)` |

## Exit criteria → where satisfied

| Criterion | Where |
|---|---|
| An owner turns on one category and only that category's actions auto-apply | `integration/ai-autopilot.integration.test.ts` |
| A proposal over the configured cap is never applied and stays clickable | same file + `src/lib/ai-autopilot.test.ts` |
| A cap above the hard ceiling is clamped by the app and refused by the DB | same file ("caps cannot be configured above the server's ceiling") |
| `journal.manual.propose` creates a draft and posts nothing to the ledger | same file ("Decision 1"), asserting `journal_entries` is unchanged |
| No customer-facing message is ever sent; only notes and local drafts | Decision 2 — no send path is imported by the executors at all |
| An autopilot change can be reverted to the exact prior state | same file ("undo"), for a price and a customer note |
| Every new table is RLS-protected and invisible across tenants | `integration/tenant-isolation.integration.test.ts` (unchanged) + this file's isolation block |
| One failing category does not stop the next | `src/lib/ai-autopilot-service.test.ts` |
| Floor mode cannot reach any autopilot surface | the existing Wave 3 isolation tests + `requireManager()` on every route |

## Repaired in passing

`ai_proactive_runs.kind` never gained `'service_reminder_drafts'`. Phase 27 Wave 10 widened
`ai_proactive_drafts.kind` (migration 0087) and started writing the new *run* kind from
`ai-proactive-service.ts`, but no migration widened the run table's CHECK — so claiming a
service-reminder run has always violated it. Migration 0097 rewrites that constraint for autopilot
anyway; omitting the reminder kind would have re-broken it, so it goes in here.

## Not in scope, deliberately

- Auto-sending anything to a customer (Decision 2), or auto-posting/approving a journal entry
  (Decision 1), or auto-logging waste (Decision 3).
- The five live floor actions — a tick fifteen minutes behind a room that changes by the minute has no
  business re-seating a table or reassigning a courier.
- A notification channel. There is no notification or push infrastructure in `src/lib`, and Kavenegar
  (Phase 24) is an OTP transport, not a comms channel. Visibility is the hub's activity list plus the
  launcher's unseen badge.
- Any change to Phase 18's billing model — autopilot spends credits through the existing
  reservation/settlement ledger with `metadata.source = "autopilot"`.
