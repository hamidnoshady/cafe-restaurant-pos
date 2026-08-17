# Phase 29 — In-House Production (تولید داخلی)

## Why

The F&B recipe model has been exactly one level deep since Phase 0:
`menu_items → menu_item_ingredients → inventory_items`. An inventory item could only ever
*enter* stock by being bought (purchase receipt), found (count surplus), transferred in, or
returned. Nothing in the app could say "we combined flour, eggs and sugar, and now we have a
cake".

That is wrong for anything a café makes itself. A whole chocolate cake is built from raw
materials **once**, yields 8 slices, and each slice is **then** sold through its own serving
recipe (one slice + chocolate sauce + a napkin). With only one recipe level the owner had two
bad options:

- put the whole cake's raw materials into the per-slice recipe — but baking happens once and
  selling happens eight times, so every sale would deduct a whole cake's ingredients, and a cake
  that is baked but unsold would show no stock at all; or
- not cost the cake at all, and price the slice by guesswork.

Phase 29 adds the missing middle step, **for the minority of menu items that need it**. Every
other menu item is untouched: an espresso still goes straight from beans to cup, one level deep.

## The load-bearing decision

**The produced good is an ordinary `inventory_items` row**, flagged `is_produced`, with its own
base unit («برش») and its own `avg_cost`. It is not a new parallel model.

That one choice is what makes the rest small. Everything downstream already operates on inventory
items, so none of it changes:

| Concern | Where it already lives | Change needed |
|---|---|---|
| Serving recipe | `menu_item_ingredients` | none |
| Sale-time deduction | `deductForOrder` → `consumeInventoryExact` | none |
| FIFO / weighted-average costing | `inventory_lots`, `carrying_value_rial` | none |
| Suggested price, cost drift | `pricing-service.ts` reads `avg_cost` | none |
| Stock counts, waste, low stock, transfers, valuation, GL reconciliation | per inventory item | none |

The genuinely new mechanics are only three: a formula, a run, and the ledger entries for the
transformation.

Nesting works for free — a formula's input may itself be a produced item (sponge base → cake →
slice). The only guard needed is a cycle check (`formulaWouldCycle`, `src/lib/production.ts`).

## Scope

- **`production_formulas` / `production_formula_inputs`** — "one batch consumes these and yields
  this much of that item", plus a default conversion (labour/overhead) cost per batch.
  Deliberately the same shape as `menu_item_ingredients`.
- **`production_runs` / `production_run_inputs`** — one actual batch: what it consumed, at what
  exact cost, and what the output was receipted at. Header + lines + per-phase event id copied
  from `inventory_transfers` (migration 0017).
- **Exact costing in both directions.** Inputs leave through `consumeInventoryExact` (so a short
  raw material opens a *priced* negative layer, like any other consumption); the output arrives
  through `applyProductionOutputCosting`, which is the positive branch of
  `applyStockAdjustmentExact` with the value **given** rather than derived — the same posture
  `applyPurchaseReceiptCosting` takes towards a supplier invoice.
- **Shortage settlement.** A café sells slices from a cake that is still in the oven often
  enough that the produced item routinely carries open shortages when a run lands. The run settles
  them oldest-first at their real cost, and only the residual becomes positive stock.
- **Reversal.** A posted run is never mutated; it is undone by a reversing document.
- **A «تولید» tab** inside `/dashboard/inventory`, and a `v_production_summary` report.

## Decisions

1. **Produced good = a flagged inventory item**, not a new table. See above.
2. **Batch cost = exact material cost + an optional conversion cost**, spread over the **actual**
   yield, not the formula's expected one. A tray that came out as 15 slices instead of 16 cost the
   same to make, so each slice cost more, and the shelf price should be able to see that.
3. **Reversal is in scope**, refused in exactly two cases — `production_output_consumed` when the
   till has already sold part of the batch, and `consumption_layer_settled` when a later receipt
   has settled a shortage one of the inputs opened. Both would mean re-costing sales that are
   already posted. This is the same posture `reverseStockCount` takes.
4. **Lives inside the `inventory` module**, not as a new module. `/api/inventory/*` already
   resolves to the `inventory` feature flag (`features.ts`) and the `inventory` F&B module
   (`industry-profile.ts`), both enforced in `withTenantScope`, so **no new gating code exists or
   is needed**. A trade without F&B's recipe-costed store never reaches these routes.
5. **`is_produced` is derived, not a checkbox.** It is set when a formula names the item as its
   output, and shown in the UI as a read-only badge. A manual checkbox could only ever contradict
   the formulas that actually exist.
6. **Two new accounts, and one of them is contra.**
   - `1310` «کالای در جریان ساخت» (WIP) — a wash account. A run issues materials into it and
     completes finished goods out of it in the same transaction, so it can never carry a balance.
     It exists so the transformation is legible in the general ledger rather than being one
     inventory→inventory entry that says nothing, and so a later phase that lets a batch stay open
     across a period boundary already has the account and the entry shape it needs.
   - `5180` «هزینهٔ تبدیل جذب‌شده در تولید» — a **contra**-expense. The baker's wage is already an
     expense (5200) and the oven's gas already an expense (5400); capitalising that effort into the
     cake must not book it twice, so absorbing it *credits* 5180, which nets against those accounts
     in the period the batch was made. The cost then re-emerges as COGS in the period the cake is
     sold, which is where it belongs. Deliberately **not** in `COST_OF_SALES_CODES` — it offsets
     overhead, so putting it inside gross profit would overstate margin when baking and understate
     it at sale.
7. **Three ledger entries per run, not one net entry.** They net to "inventory up by the conversion
   cost, 5180 credited, WIP zero", which two lines could also produce — but the net says nothing
   about what happened, and "how much did we put into production last month" should be answerable
   from the ledger.

| # | Debit | Credit | Amount | `posting_kind` |
|---|---|---|---|---|
| 1 | 1310 WIP | 1300 موجودی | material cost | `production_materials` |
| 2 | 1310 WIP | 5180 جذب‌شده | conversion cost (skipped when zero) | `production_conversion` |
| 3 | 1300 موجودی | 1310 WIP | total cost | `production_output` |

Plus `postExactNegativeSettlementEntry` when the output closed a shortage, exactly as a purchase
receipt does. A reversal swaps every direction, under its own `posting_kind`s.

8. **Posted through the domain-event engine**, not a hand-written ledger function — the path every
   Phase 21/27 trade uses and the one F&B's own `fnb-posting-rules.ts` established for inventory
   routes. Six rules in `src/lib/production-posting-rules.ts`.
9. **Guarded with `requireRole("owner", "manager")`**, matching every neighbouring inventory route,
   rather than introducing `requirePermission(PERMISSIONS.inventoryAdjust)` as a second convention
   inside one module.

## Where each piece is

| Piece | File |
|---|---|
| Schema, RLS, accounts, report view | `migrations/0090_production_runs.sql` |
| Accounts in the template | `src/lib/coa-template.ts` (`workInProgress`, `appliedConversionCost`) |
| Pure arithmetic | `src/lib/production.ts` (+ `production.test.ts`) |
| Output receipt costing | `src/lib/production-output-costing.ts` |
| Formulas, runs, reversal | `src/lib/production-service.ts` |
| Ledger rules | `src/lib/production-posting-rules.ts` |
| API | `src/app/api/inventory/production/**` |
| UI | `src/app/dashboard/inventory/production-section.tsx` |
| Report | `v_production_summary`, registered in `src/lib/reports.ts` |

## Exit criteria → where satisfied

| Criterion | Where |
|---|---|
| A batch consumes its scaled inputs at exact cost and receipts the output at materials + conversion | `integration/production-runs.integration.test.ts` — "consumes the scaled inputs…" |
| Cost is spread over the actual yield, not the expected one | same test (15 slices from a 16-slice formula → 113,333.33) |
| WIP nets to zero; inventory rises by exactly the conversion cost | same file — "nets WIP to zero…" |
| A produced slice costs out through the ordinary sale path, unchanged | same file — "costs a slice out through the same consumption path an order uses" |
| Slices sold before the cake was baked are settled at real cost | same file — "settles a shortage…" |
| A reversal returns stock, lots, carrying value and the ledger to their prior state | same file — "returns stock and the ledger to exactly where they were" |
| Reversal is refused once part of the batch has been sold | same file — "refuses once part of the batch has been sold" |
| Both costing methods behave | same file — "weighted-average costing" block |
| Every new table is RLS-protected and the view is `security_invoker` | `integration/tenant-isolation.integration.test.ts`, unchanged |
| Formula scaling, unit cost, yield variance, cycle detection | `src/lib/production.test.ts` |

## Not in scope, deliberately

- **A batch that stays open across a period boundary.** Every run issues and completes in one
  transaction, so WIP is always zero at rest. The account and entry shape are in place if this is
  ever wanted.
- **Unit conversion between a formula's output and its consumers.** A run producing "2 litres of
  syrup" consumed in millilitres is expressed by giving the produced item a base unit of `ml` and a
  yield of 2000 — the same rule `purchase_unit_factor` follows for buying. There is no unit registry
  in this codebase and this phase does not add one.
- **Planned vs. actual material variance.** The formula's expected material cost is shown in the
  editor as an estimate; a run is costed by the exact path and the two can legitimately differ. A
  report on that gap is a separate question from recording production.
