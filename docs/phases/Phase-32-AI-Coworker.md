# Phase 32 — «همکار هوشمند» (the AI coworker)

## Why

The assistant could already answer questions about the business (Phase 18b), and
could already act on its own within owner-set caps (Phase 31). What it could not
do was take an instruction and keep it.

Both existing shapes have the model deciding *what is worth doing*: a chat turn
answers what you just asked, and an autopilot run looks at the business and
proposes something. An owner who already knows the job — «هر شب که شیفت بسته
می‌شود، نانی که مانده را ضایعات بزن» — had nowhere to put that sentence. They
could type it into the chat every night, or wait and hope the model proposed it.

Accounting is full of jobs of exactly that shape: the same small write, on the
same trigger, forever. They are not hard, they are just relentless, and they are
the ones a café owner actually stops doing. So this phase adds the missing noun.

## What a job is

A **job** is a piece of work an owner describes once:

| | |
|---|---|
| **template** | which ready-made kind of work (write off waste, run the morning bake, draft the low-stock order, review the books) |
| **params** | the owner's intent — *which* item, *why*, *which* formula. Never a quantity. |
| **trigger** | a business event (`shift_open`, `shift_close`, `day_close`), a time of day, or nothing (run it by hand) |
| **approval** | «قبل از ثبت بپرس» or «خودت ثبت کن» |

When it fires it produces a **run**, which holds the facts it read, the actions
it wants to take, and what happened to each. A run that needs a human waits in
the approval inbox at `/dashboard/ai` → «همکار هوشمند».

## Decisions

### 1. A job is deterministic. The model is not in the loop when one fires.

Every action a job produces is built by a pure function in
`ai-coworker-templates.ts` from parameters and database facts. No provider call,
no sampled token, no credits.

This is the decision the whole phase rests on. An owner cannot meaningfully
pre-approve "whatever the model felt like at 02:00" as a standing instruction —
but they can pre-approve "write off the bread that is left, as spoilage",
because that sentence has exactly one meaning every night. Determinism is also
what lets the integration test assert exact quantities and exact Rial amounts,
which is the only way to have any confidence in something that writes to a
ledger unattended.

The model's role is unchanged and still valuable: it is how an owner *talks
about* the work (`run_accounting_review`, `list_coworker_jobs`), and how they
get help setting a job up. It is not what runs it.

Two consequences fall out. A job is gated on the `ai_assistant` entitlement
alone — **not** on `ai_proactive_settings.enabled`, which is the *credit* opt-in,
because a job spends nothing. And the coworker tick runs on every 15-minute tick
rather than only at the digest hour, because "the shift just closed" cannot wait
until 08:00 tomorrow.

### 2. Quantities are read at fire time; params hold intent only.

`params` for the bread job says «نان، هرچه مانده، فساد». It does not say "12".
How much bread is on the shelf tonight is a fact only `stock_movements` knows,
and it is different every night. The builder is handed the current figure and
clamps a fixed quantity down to what actually exists — writing off more than
exists would open a negative layer at a price nobody paid, which is a costing
bug, not a write-off.

This is the same rule Phase 31 states for caps ("the values caps are measured
against are read from the database, never taken from the model's own payload"),
extended from *checking* a number to *producing* one.

### 3. Waste can now be logged — narrowly, and only from a human-authored job.

Phase 31 decided that waste is detected and flagged but never logged, "because
*why* stock left is a fact only a person in the room has". That reasoning is
still exactly right for an autopilot run, and it still holds: `inventory.waste.log`
is marked `coworkerOnly` in `ACTION_CATALOG`, and `actionTypesForCategory`
excludes it — so the model can still never discover on its own that some stock
should be written off.

What changed is that a coworker job supplies the missing fact. The owner names
the item and the reason when they create the job, in advance. The person in the
room is still the source of "why"; they just said it earlier than the write.

The `waste` autopilot category, which had no executable action at all and
therefore ceilings of 1 item and 1 run per day, is widened to something a real
night can use (15 items, 8 runs) and gains the monetary ceiling it never needed
before — because a write-off has a real cost and, unlike a stock count, no
honest one-click undo.

### 4. A job cannot be a way around the autopilot caps.

`approvalMode: "auto"` is necessary but not sufficient. Every action still goes
through Phase 31's `evaluateAutopilotProposal` against the same per-category
settings, and all three of these must hold before anything is written
unattended:

1. the owner set this job to `auto` (and only an **Owner** may — a manager can
   create jobs, the same split the autopilot money category uses);
2. a real user's authority backs it (`ai_coworker_jobs.authorized_by`);
3. the category's caps admit this specific payload, measured against values read
   from the database.

A "no" on any of them is never a drop. The action is written to the run, shown
with the reason it was held, and applies on the identical executor path when the
owner taps approve. Over-cap means *held*, not *dropped* and not *forced* —
Phase 31's rule, unchanged.

### 5. The accounting review is a rule engine, not a prompt.

«حساب‌هایم را بررسی کن و اشکال‌ها را بگو» is the request `accounting-review.ts`
exists for, and it is deliberately not a model call. Twelve rules, each with an
arithmetic or referential basis: a debit total that differs from a credit total,
an inventory event that never reached the ledger, a settled sale with no entry,
a cheque past its due date, a chart missing an account its own industry template
requires.

A language model asked to audit a trial balance will produce plausible findings,
and a plausible finding about money is worse than none — the owner cannot tell it
from a real one. The assistant *explains* what the rules found; it does not find
it.

The review reports and never writes. Every finding carries a severity, a count,
the money involved where that is knowable, a suggestion, and the screen that
fixes it. Choosing the correcting entry is the accountant's call.

A rule whose query fails degrades to "found nothing" so the other eleven still
run — but the failure is *named* in `unavailableChecks`, shown in the UI, and
asserted empty by the integration test. A check that quietly returns nothing is
indistinguishable from clean books, which is the worst possible failure for an
audit tool.

### 6. Applying an approved action opens no new mutation path.

Every apply — auto or approved — runs Phase 31's `AUTOPILOT_EXECUTORS`, which
call the same service function the route handler calls. Two new executors join
them (`wasteLog`, `productionRun`), and waste logging was lifted out of its route
handler into `waste-service.ts` so the route and the executor share one
implementation rather than two.

Every apply also writes the same `ai_action_audit` row a chat apply writes,
tagged `source = 'coworker'` — so the hub's history still answers "every change
the assistant made to this business" in one list.

### 7. An automated write is never anonymous — including over the API.

`ai_coworker_jobs.authorized_by` is the human whose authority an unattended write
runs under, re-stamped on every edit. Over the public API, where there is no
session, a write is attributed to the **user who issued the API key**; a key
whose issuer is gone may read but may not author work.

## Scope

### Schema — `migrations/0100_ai_coworker.sql`

- `ai_coworker_jobs` — the definition, with a CHECK that a job cannot be half
  event and half schedule (and so fire twice).
- `ai_coworker_events` — the queue. `shift-service` and `business-day-service`
  enqueue; the tick consumes. Decoupled because closing a shift is a cashier's
  foreground request and must never fail because of a background job.
- `ai_coworker_runs` — one firing, with `UNIQUE (job_id, dedupe_key)`. That
  index is the entire idempotency story: two ticks racing, or one retried,
  produce one run rather than two write-ups of the same night.
- `ai_coworker_run_actions` — one row per action, so a five-item write-off can
  record that line 3 failed without lying about the other four.
- `ai_action_audit.source` gains `'coworker'`; `api_keys.scopes` gains three.
- RLS on all four tables, `tenant-isolation.integration.test.ts` proves it.

### Templates

`shift_close_waste`, `shift_open_production`, `shift_open_stock_topup`,
`low_stock_purchase_draft`, `accounting_review`. Each declares the module it
needs (refused at creation for a trade that lacks it, not merely hidden), its
scope (per branch, or business-wide), and which catalogue actions it can emit.

### Catalogue additions

`inventory.waste.log` (waste, `coworkerOnly`), `inventory.production.run`
(inventory, reversible through Phase 29's own reversal), and `menu.item.create`
— which is deliberately **not** autopilot-eligible in any category: adding
something a customer can order is a product decision, not a bookkeeping one, so
it stays chat-and-confirm forever.

### Public API

`/api/v1/coworker/{templates,jobs,runs}` and `/api/v1/accounting/review`, under
three new scopes (`coworker.read`, `coworker.write`, `accounting.read`) and the
`ai_assistant` entitlement — so a business can build a sub app around its own
coworker.

### UI

A «همکار هوشمند» tab at `/dashboard/ai`, second in the strip because after the
first week an owner clears the inbox far more often than they chat: the approval
inbox, the job list with a template gallery, and the accounting review. The
floating launcher's badge counts pending runs alongside autopilot activity — one
badge, because two would teach people to ignore both.

## Exit criteria

| Criterion | Where |
|---|---|
| An owner can define a recurring job from a template, with an event or schedule trigger | `ai-coworker.ts`, `ai-coworker-templates.ts`, `/dashboard/ai` → «همکار هوشمند» |
| Closing a shift makes the job run, end to end, with real stock and a real ledger entry | `integration/ai-coworker.integration.test.ts` — "writes off the night's remaining bread" |
| Quantities follow the shelf, not the stored job | same file — "follows the shelf, not the job" |
| One event produces one run however often the tick runs | same file — "fires once per event however often the tick runs" |
| «بپرس» writes nothing until a human approves, then writes | same file — "writes nothing while the owner has asked to be asked" |
| A job cannot exceed the autopilot caps, and over-cap is held rather than dropped | same file — "cannot be a way around the autopilot caps"; `ai-coworker.test.ts` |
| The accounting review finds real defects and changes nothing | same file — "finds a real unbalanced entry"; `accounting-review.test.ts` |
| No check silently degrades | `unavailableChecks`, asserted empty in the integration test |
| The whole feature is drivable from a sub app | `/api/v1/coworker/*`, `/api/v1/accounting/review` |

## Fixed on the way through

Three queries in the existing AI subsystem named columns that do not exist —
`inventory_items.quantity` and `inventory_items.last_unit_cost` (on-hand is
summed from `stock_movements`; the cost column is `avg_cost`), and
`employees.name`. They were in Phase 31's cap-measurement context, its
cost-drift facts, and would have raised an error rather than returned a number.
Corrected with the phase because it moved and extended that code.

## Not in scope, and why

- **A job that messages a customer.** Phase 31 Decision 2 stands: nothing
  customer-facing is ever sent unattended, only internal records written.
- **A job that posts a journal entry.** Phase 31 Decision 1 stands: an entry is
  only ever drafted into Phase 16's human approval queue. The review deliberately
  proposes no entries at all.
- **A free-text job** («هر شب هر کاری لازم بود بکن»). That is autopilot, which
  already exists and is capped accordingly. A coworker job is a template because
  a standing instruction has to mean one thing.
