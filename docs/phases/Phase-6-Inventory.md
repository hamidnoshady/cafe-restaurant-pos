# Phase 6 — Inventory

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–5
**Goal:** Completing an order correctly deducts recipe-based ingredient quantities and computes correct COGS, under either costing method.

---

## Scope

- `InventoryItems` CRUD (raw ingredients: unit, reorder threshold)
- `Recipes` (BOM): link `MenuItems` (and modifiers, per Phase 2 Q2 answer) to `InventoryItems` with required quantities
- `InventoryLots` for FIFO tracking; running `avg_cost` field for Weighted Average
- Costing strategy pattern: single `InventoryCostingStrategy.calculateCOGS()` interface, FIFO and Weighted Average implementations behind it, selected at setup (Phase 1) and locked
- Auto-deduction: completing an order deducts ingredient quantities per recipe, consuming lots correctly under FIFO
- Purchasing/goods-received flow: logging a supplier delivery increases stock and records cost (feeds costing)
- Waste/spoilage logging: separate from sales deduction, visible shrinkage tracking
- Stock counts/physical audits: periodic manual count entry, variance calculated against system stock
- Low-stock alerts based on reorder threshold
- Unit conversions (e.g. purchase in kg, recipe uses grams)

## Out of scope (later phases)

- Ledger posting of these events (Phase 7 — this phase produces the StockMovements/costing data; Phase 7 turns them into journal entries)

## Exit criteria

- Completing a test order visibly deducts the correct ingredient quantities per its recipe
- COGS calculates correctly under FIFO (oldest lot consumed first) when tested with multiple lots at different costs
- COGS calculates correctly under Weighted Average when tested against the same scenario
- A purchase/goods-received entry correctly increases stock and updates costing basis
- A waste entry correctly reduces stock without affecting sales figures
- Low-stock alert fires correctly when an ingredient crosses its reorder threshold

---

## Questions to answer before/during this phase

1. **Unit conversion list** — what are the actual purchase units vs. recipe units you use (e.g. beans bought in kg, used in g per drink; milk bought in liters, used in ml)? A full list would let Claude Code build the conversion table accurately.
2. **Suppliers** — do you need a `Suppliers` entity (name, contact, items they supply) now, or is "purchase entry" enough without formal supplier records for v1?
3. **Purchase orders vs. direct receiving** — do you want a formal PO step (create PO → receive against PO), or just direct "goods received" entries without a prior PO?
4. **Stock count frequency** — daily, weekly, or ad hoc physical counts? Should the system prompt/schedule these?
5. **Waste categories** — do you want waste reasons categorized (e.g. spoilage, prep error, customer return, staff meal), or just a single generic waste entry type?
6. **Modifier-level inventory impact** — following up on Phase 2 Q2: confirm which modifiers (if any) actually swap or add ingredients, so their recipes can be built correctly here.

---

## Decisions on Phase 6 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Unit conversion list** — no fixed global table; instead each `inventory_items` row carries its own `purchase_unit` + `purchase_unit_factor` (how many base/recipe units one purchase unit is worth, e.g. `unit = 'g'`, `purchase_unit = 'kg'`, `factor = 1000`). Recipes, stock movements, and lots always work in the item's base unit; the purchase-entry screen converts the entered purchase-unit quantity to base units before storing (`convertPurchaseQuantity`, `src/lib/inventory.ts`). This handles any item's conversion without hard-coding a specific ingredient list.
2. **Suppliers** — kept, as a light entity (name, phone, notes) — the foundation schema (migration `0001`) already staged a `suppliers` table for this phase. A purchase's supplier is optional.
3. **Purchase orders vs. direct receiving** — both are supported through one status machine already staged in `purchases.status` (`draft → ordered → received`, or `cancelled` from either): `draft → received` direct receiving, or `draft → ordered → received` as a formal PO step. Receiving is the only transition that touches stock (`PATCH /api/inventory/purchases/[id]`).
4. **Stock count frequency** — ad hoc/manual only in v1; no scheduling or prompting. A count is a one-off entry (`POST /api/inventory/stock-counts`) that compares counted quantity against system stock at that moment and posts the variance as an `adjustment` stock movement.
5. **Waste categories** — categorized: a `waste_reason` enum (`spoilage`, `prep_error`, `customer_return`, `staff_meal`, `other`) is required on every waste entry.
6. **Modifier-level inventory impact** — a `modifier_ingredients` table holds a signed `quantity_delta` per (modifier, inventory item), applied on top of the menu item's own recipe when that modifier is selected on an order line. Positive = pure addition (e.g. "extra shot" adds coffee); a swap (e.g. "oat milk") is two rows — a negative delta on the ingredient being replaced and a positive delta on its replacement. Configured per modifier in the dashboard's "دستورالعمل مصرف" (Recipes) tab; which modifiers get an entry is an ongoing menu-management decision, not a fixed list.

**Other decisions made while building:**

- **Costing strategy** — one interface (`InventoryCostingStrategy.calculateCOGS`, `src/lib/inventory-costing.ts`) with `fifoCostingStrategy` and `weightedAverageCostingStrategy` implementations, selected by the setup wizard's already-locked `inventory.costing` setting (Phase 1). FIFO consumes `inventory_lots` oldest-`received_at`-first; weighted average prices every unit at the item's running `avg_cost`, rolled forward on each purchase receipt (`calculateNewAverageCost`). Both are pure and unit-tested against the same multi-lot scenario (`inventory-costing.test.ts`).
- **Deduction trigger and atomicity** — `order_items` become immutable once an order leaves `open` (enforced since Phase 2/4), and the only transition out of `open` into a state that should consume stock is payment/completion. `POST /api/orders/[id]/pay` was made transactional (it previously ran two independent statements) so payment, order completion, and deduction commit or roll back together — never a paid order with no deduction, or vice versa.
- **Stock shortfall (going negative)** — if FIFO lots don't cover the quantity being deducted (a bookkeeping gap, e.g. a missed purchase entry), the shortfall is still costed — at the last-consumed lot's cost, or the item's `avg_cost` if there were no lots at all — rather than blocking order completion. `ConsumptionResult.shortfall` reports it back for future surfacing (e.g. a reporting phase) without failing the sale.
- **COGS storage** — not persisted as a column anywhere; it's always reconstructable as `SUM(quantity * unit_cost)` over an order's `type = 'sale'` stock movements (`stock_movements.source_type = 'order'`), keeping the append-only ledger the single source of truth per the existing `stock_movements` convention.
- **Purchase cost entry** — a purchase line is entered as quantity (in the item's purchase unit) + total cost for that line (however the supplier invoiced it), not a per-unit cost — suppliers invoice by the purchased quantity, and deriving `unit_cost = round(totalCost / baseQuantity)` avoids fiddly fractional per-gram entry.
- **Role gating** — all inventory admin endpoints (items, recipes, suppliers, purchases, waste, stock counts) are owner/manager only, matching the rest of the app's back-office surface (menu CRUD, setup). `GET /api/inventory/low-stock` additionally allows cashier, since a low-stock signal is useful at the point of sale too.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Completing a test order deducts correct ingredient quantities per recipe | `deductForOrder` (`src/lib/inventory-service.ts`), called from `POST /api/orders/[id]/pay`; expands non-voided `order_items` + `order_item_modifiers` via `computeIngredientRequirements` (`src/lib/inventory.ts`) against `menu_item_ingredients` + `modifier_ingredients` |
| COGS correct under FIFO (oldest lot first, multiple lots/costs) | `fifoCostingStrategy.calculateCOGS` (`src/lib/inventory-costing.ts`), `inventory-costing.test.ts` |
| COGS correct under Weighted Average, same scenario | `weightedAverageCostingStrategy.calculateCOGS` + `calculateNewAverageCost`, same test file |
| Purchase/goods-received entry increases stock and updates costing basis | `POST /api/inventory/purchases` (draft) → `PATCH /api/inventory/purchases/[id]` with `status: 'received'` → `receivePurchase` (`src/lib/inventory-service.ts`): writes a `purchase` stock movement, plus a new `inventory_lots` row (FIFO) or an `avg_cost` roll-forward (weighted average) |
| Waste entry reduces stock without affecting sales figures | `POST /api/inventory/waste` → `consumeInventory(..., type: 'waste')`; a distinct `stock_movements.type` from `'sale'`, categorized via `waste_reason` |
| Low-stock alert fires on crossing the reorder threshold | `crossedLowStockThreshold` (`src/lib/inventory.ts`) checked inside `consumeInventory`; broadcasts `inventory.low_stock` (`src/lib/realtime.ts`) live, and `GET /api/inventory/low-stock` for the dashboard's banner (`/dashboard/inventory`) |

Dashboard UI: `/dashboard/inventory` (`src/app/dashboard/inventory/inventory-manager.tsx`) — tabs for items, recipes (menu item + modifier), suppliers, purchasing, waste, and stock counts, plus a live low-stock banner.
