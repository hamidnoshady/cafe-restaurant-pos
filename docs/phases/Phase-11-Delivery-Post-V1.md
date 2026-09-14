# Phase 11 — Delivery (Post-v1)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–10 (full v1 complete)
**Goal:** Activate delivery as a real order type — the schema (`couriers`, `deliveries`, `order_type: delivery`, `delivery_status`) has existed since Phase 0/2 but had no UI until now.

> Note: this is the "Phase 10 — Delivery" from the original roadmap. Backup (built first) took the Phase 10 slot, so delivery is Phase 11 here; the source spec is unchanged.

**Stack reminder:** Next.js + React + TypeScript, Tailwind + shadcn/ui, Node.js/TypeScript backend.

---

## Scope

- Delivery order intake (address, phone, courier assignment, flat fee) — from the cashier POS screen
- Courier/dispatch UI — assigning orders to couriers, status tracking (`pending → assigned → out_for_delivery → delivered`, plus `failed`)
- Delivery-specific reporting (delivery-time performance, courier performance) added to Phase 8's reporting engine

## Exit criteria

- A delivery order can be placed, assigned to a courier, and tracked through to delivered status
- Delivery orders correctly flow through existing inventory deduction and ledger posting from Phases 6–7 with no schema changes needed
- Delivery performance reports available alongside existing standard reports

---

## Questions to answer before/during this phase

1. **Courier model** — in-house delivery staff, third-party courier service integration, or both?
2. **Customer tracking** — do you want a customer-facing tracking link/page, or is internal status tracking (staff-only) sufficient?
3. **Delivery zones/fees** — do you need zone-based delivery fee calculation, or a flat fee (or free) delivery?
4. **Third-party platform integration** — any need to integrate with external delivery platforms, or is this exclusively your own in-house delivery?

---

## Decisions on Phase 11 open questions

Defaults chosen to keep moving; each is easy to revisit, and each is what the schema shipped in Phase 0 already anticipates.

1. **Courier model** — **in-house couriers only.** The `couriers` table (name, phone, `is_active`, per location) is the roster; a delivery is dispatched to one of these. No third-party courier abstraction was built — that would be Q4's integration, deliberately out of scope. Couriers are managed from the dispatch board (`/accounting/delivery`, Owner/Manager), so no new setup-wizard step was needed.
2. **Customer tracking** — **internal (staff-only) status tracking.** Status lives on the dispatch board and advances staff-side; there is no customer-facing tracking token or public page. The schema has no per-delivery public token, so a tracking link would be new scope (a token column + an unauthenticated route on the middleware allowlist). Nothing customer-facing was built.
3. **Delivery zones/fees** — **flat per-order fee, entered at intake.** `deliveries.fee` holds it. The fee rides on the order as its `service_charge` (`orders.service_charge`, which `computeOrderTotals`'s existing `serviceCharge` param already folds into `total`), so it's billed and posted with zero delivery-specific ledger handling. No zone table / geocoding was built — zone-based pricing would be new scope.
4. **Third-party platform integration** — **none; exclusively in-house.** No external platform (Snapp/Tapsi-style) integration. This keeps the on-site, no-cloud-dependency story intact (Phase 0/9): delivery is just another order type on the same local server.

**Other decisions made while building:**

- **The delivery fee is the one place delivery touches money, and it does so through an existing column.** Rather than a new "delivery fee" ledger account or a schema change, the flat fee is written to `orders.service_charge` at creation (`order-mutations.createOrder`), so it's already inside `orders.total` when the unchanged pay route (`/api/orders/[id]/pay`) records the payment and posts the Phase 7 revenue + COGS entries. This is what makes exit criterion 2 true *by construction* — a delivery order's payment, inventory deduction, and ledger posting run the identical code path as dine-in/takeaway.
- **Lifecycle is `pending → assigned → out_for_delivery → delivered`, with `failed` reachable from any non-terminal state.** The legal transitions are a pure table in `src/lib/delivery.ts` (`canTransitionDelivery`, unit-tested), mirrored by the service guard. `out_for_delivery`/`delivered` require a courier (`requiresCourier`); `dispatched_at`/`delivered_at` are stamped on those transitions so the reporting views can measure door-to-customer time. Assigning a courier at intake starts the delivery `assigned`; leaving it blank starts it `pending` on the board.
- **Order labels get a `D-` prefix.** `formatQueueLabel` (`src/lib/orders.ts`) now returns `D-<n>` for delivery, alongside `T-<n>` (takeaway) and `#<n>` (dine-in) — one shared label used on the result screen, dispatch board, and kitchen ticket.
- **Offline parity.** Delivery orders created while offline replay through the same `createOrder` path (`sync-events.ts` carries the `delivery` payload), so an offline-created delivery behaves identically to an online one — same as every other order type since Phase 5.
- **No new migration to the transactional tables.** `0011_delivery.sql` adds *only* the two reporting views; `couriers`/`deliveries`/the enums were already in `0001_foundation.sql`.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Delivery order placed → assigned → tracked to delivered | Intake: `src/app/dashboard/pos/pos-screen.tsx` (delivery type + address/phone/fee/courier) → `POST /api/orders` → `order-mutations.createOrder` + `delivery-service.createDeliveryForOrder`. Dispatch/track: `src/app/dashboard/delivery/*`, `GET /api/deliveries`, `PATCH /api/deliveries/[id]` (`assignCourier`, `transitionDelivery`). Lifecycle rules: `src/lib/delivery.ts` (+ `delivery.test.ts`). |
| Inventory + ledger flow through unchanged | Delivery orders pay via the unchanged `/api/orders/[id]/pay` (deduction + payment/COGS entries). Fee folded into `orders.service_charge` → `total` in `createOrder`, so no delivery-specific posting. No changes to `inventory-service.ts` / `ledger-service.ts`. |
| Delivery reports alongside standard reports | Views `v_delivery_performance`, `v_courier_performance` (`migrations/0011_delivery.sql`); whitelisted in `REPORT_VIEWS` and added to `STANDARD_REPORTS` (`src/lib/reports.ts`), so they render in `/accounting/reports` and are pinnable to the dashboard like any standard report. |
