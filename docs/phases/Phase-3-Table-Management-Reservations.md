# Phase 3 — Table Management & Reservations

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0, Phase 1, Phase 2
**Goal:** Real floor plan replaces the Phase 2 table stub. Walk-ins and reservations both correctly open table sessions.

---

## Scope

- Floor plan editor: drag-drop tables onto a canvas, grouped into sections
- Table state machine: Free → Occupied → Bill Requested → Needs Cleaning → Free, color-coded on the map
- `TableSession` lifecycle: opens on seating, groups multiple order rounds, closes on payment
- Merge/split tables (joining tables for large groups)
- Split-bill support (splitting one table session's charges across guests)
- Waiter-to-section assignment (which waiter owns which tables — used by Waiter app in Phase 4)
- Reservations: booking (date/time, party size, customer name/phone, table/section), states (Confirmed → Seated → No-show → Cancelled), overlap/conflict detection
- Seating a reservation creates the `TableSession` directly, carrying over party size/name

## Out of scope (later phases)

- Waiter mobile app itself (Phase 4) — this phase builds the data/logic layer waiter app will use
- Kitchen display (Phase 4)

## Exit criteria

- Manager can design a floor plan matching the real venue layout
- A walk-in can be seated at a free table, opening a correct `TableSession`
- A reservation can be booked, shows correctly on the floor plan at its time window, and seating it correctly converts to an active `TableSession`
- Two overlapping reservations on the same table are flagged
- Splitting a table's bill across N guests produces correct, separately payable amounts

---

## Questions to answer before/during this phase

1. **Floor plan realism** — do you want a simple grid-based layout, or a true freeform canvas matching your actual venue's physical layout (walls, irregular table shapes)?
2. **Reservation lead time / rules** — minimum notice required, max party size online vs. phone-in, any deposit/prepayment requirement for reservations?
3. **No-show handling** — after how long past reservation time should a table auto-flag as no-show (or is this always manual)?
4. **Merge/split** — when tables are merged, do all open orders on both tables combine into one bill, or stay separate but share physical space?
5. **Bill splitting method** — even split by guest count, itemized (each guest pays for their own items), or both needed?
6. **Table cleaning step** — do you want a real "needs cleaning" state requiring staff to mark it clean before it's bookable again, or should tables go straight back to Free on payment?

---

## Decisions on Phase 3 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Floor plan realism** — a **freeform canvas**. Each table carries a position (`pos_x`/`pos_y`), size (`width`/`height`), and shape (`rect`/`circle`), grid-snapped in the editor; tables are grouped into named `floor_sections`. This is a superset of a grid layout — you can still line tables up on a grid — without modelling walls/irregular room outlines (deferred; not needed to match table placement).
2. **Reservation lead time / rules** — **no minimum lead time and no deposit/prepayment** enforced in v1. A booking only requires a customer name, a party size ≥ 1, and a time that isn't in the past (a 1-hour tolerance is allowed). Turn time defaults to **90 minutes** per reservation (`duration_minutes`, editable 15–600), which is what overlap detection uses. No separate online-vs-phone party-size cap — all bookings are staff-entered in v1.
3. **No-show handling** — **manual**. Marking a reservation `no_show` (or `cancelled`) is a staff action. The UI *highlights* a still-booked reservation once it is `NO_SHOW_GRACE_MINUTES` (default 15) past its start (`isNoShowOverdue`), but nothing auto-cancels.
4. **Merge/split** — merged tables **combine into one bill**: a single `TableSession` spans several physical tables via `table_session_tables`, and every order round on any of those tables bills together. A partial unique index (`idx_table_session_tables_active`) guarantees a table belongs to at most one active session, so double-seating is impossible even under concurrency.
5. **Bill splitting method** — **both**. `evenSplit(total, n)` divides the session bill into N shares that sum exactly to the total (remainder rial handed to the earliest payers, so shares differ by at most 1 rial). `itemizedSplit(lines, n)` charges each line to a chosen payer, with unassigned lines pooled and split evenly — also summing exactly to the bill. Line amounts are each order line's post-discount, tax-inclusive total from the same `computeOrderTotals` used everywhere else. (Actual payment capture arrives with the Phase 4 payment flow; this phase produces the separately-payable amounts.)
6. **Table cleaning step** — a **real `needs cleaning` state**. Closing a session moves its tables to `cleaning`; a table isn't seatable again until staff mark it clean (`cleaning → free`). The full state machine is `free → seated → bill_requested → cleaning → free`, with `free ⇄ out_of_service` as a manual maintenance side-track (`canTransitionTable`).

### Notes for later phases

- **Payments (Phase 4):** closing a session is currently a manual end-of-visit action. When the payment flow lands, posting payment should drive `closeSession` automatically, and `order.status` should move `open → completed` at that point.
- **Waiter app (Phase 4):** a section's `assigned_waiter_id` is the data the waiter app reads to scope a waiter to their tables.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Manager designs a floor plan matching the venue | `/dashboard/floor` edit mode (`src/app/dashboard/floor/floor-plan.tsx`): drag to place, add/edit tables & sections, assign waiters → `/api/tables`, `/api/tables/[id]`, `/api/floor/sections*` |
| Walk-in seated at a free table opens a correct `TableSession` | `openSession` (`src/lib/table-session-service.ts`) via `POST /api/table-sessions`; dine-in orders auto-attach through `ensureSessionForTable` in `POST /api/orders` |
| Reservation booked, shown on the floor at its window, seating converts to an active session | Booking + conflict check in `POST /api/reservations`; upcoming-reservation overlay in `GET /api/floor`; `PATCH /api/reservations/[id]` `action:"seat"` → `openSession` |
| Two overlapping reservations on the same table are flagged | `findConflicts`/`windowsOverlap` (`src/lib/reservations.ts`) enforced in `tableConflicts` (`src/lib/reservation-service.ts`); returns `409 reservation_conflict` |
| Splitting a bill across N guests → correct, separately payable amounts | `evenSplit` / `itemizedSplit` (`src/lib/table-sessions.ts`) over `computeSessionBill`, via `POST /api/table-sessions/[id]/split`; UI in `session-panel.tsx` |

Schema: `migrations/0004_table_management_reservations.sql`. Unit tests: `src/lib/table-sessions.test.ts`, `src/lib/reservations.test.ts`.
