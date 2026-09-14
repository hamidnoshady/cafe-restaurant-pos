# Phase 4 — Waiter + Kitchen Apps, Real-Time Sync

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0, Phase 1, Phase 2, Phase 3
**Goal:** Orders placed anywhere (cashier, waiter) appear live on the kitchen display and update everyone's view of the relevant table in real time, over the local network.

---

## Scope

- WebSocket layer on the local server (Socket.IO or native `ws`)
- Waiter (Garson) app: shows only tables/sections assigned to the logged-in waiter, order entry against an open `TableSession`, "send to kitchen" action
- Kitchen Display System (KDS): live ticket queue, per-item status (`ordered → cooking → ready`), "bump" action to mark ready, visual aging (tickets sitting too long get flagged)
- Order/`OrderItem` status now fully wired: cashier, waiter, and kitchen views all reflect the same live state
- Table state on the floor plan (Phase 3) updates live as orders progress

## Out of scope (later phases)

- Offline queueing when LAN itself drops (Phase 5 — this phase assumes LAN is up)
- Actual printing (Phase 5)

## Exit criteria

- An order placed on the waiter app appears on the KDS within ~1 second
- Marking an item "ready" on the KDS updates the waiter app and cashier view live
- Multiple waiters/cashier/KDS open simultaneously never show stale or conflicting order state
- Kitchen can see which table/order-type each ticket belongs to at a glance

---

## Questions to answer before/during this phase

1. **Kitchen ticket grouping** — should tickets group by table (all items for table 5 on one ticket) or by station (all drinks together, all food together, if you have separate prep areas)?
2. **Ticket aging thresholds** — after how many minutes should a ticket visually flag as "running late" on the KDS?
3. **Waiter notifications** — when an item is marked "ready" in the kitchen, does the waiter need an active notification (buzz/alert), or is checking the app screen enough?
4. **Number of kitchen stations** — one shared KDS screen, or multiple screens for different stations (hot kitchen, cold/drinks, dessert)?
5. **Device count** — roughly how many waiter phones/tablets and kitchen screens will run simultaneously? (Affects WebSocket connection load testing.)
6. **Manager visibility** — should managers see a live "all tables" overview during service, separate from the waiter's filtered view?

---

## Decisions on Phase 4 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Kitchen ticket grouping** — **by table**. A ticket's key is the dine-in order's `table_session_id` (so every round sent to a table's open session collapses onto one ticket, growing as new items arrive) or the `order_id` for takeaway/delivery, which has no session to group by. No station split in v1 — see (4).
2. **Ticket aging thresholds** — **10 minutes** from `sent_to_kitchen_at` (`DEFAULT_TICKET_AGING_MINUTES`, `src/lib/order-item-status.ts`), a code constant rather than a settings-UI value in v1 — trivial to change or later promote to a per-business setting.
3. **Waiter notifications** — **screen only**. The waiter board refetches live off the same WebSocket events the KDS uses (a `ready` bump broadcasts immediately), and a table with a ready item shows a green "N آماده" badge. No push/sound alert in v1; nothing in the schema blocks adding one later.
4. **Number of kitchen stations** — **one shared KDS screen** (`/accounting/kitchen`). `printer_kind` already distinguishes `receipt`/`kitchen` for Phase 5 printing, but v1 doesn't split tickets by station — every kitchen-role login sees the same queue.
5. **Device count** — not load-tested; the `ws` in-process registry (`src/lib/realtime.ts`) is a plain `Set` of open sockets, adequate for the handful of concurrent waiter/KDS/cashier screens a single-location café runs. Revisit if a location needs more than a few dozen simultaneous connections.
6. **Manager visibility** — **yes**. Owner/Manager logins see every section on `/dashboard/waiter` (the waiter-only filter by `floor_sections.assigned_waiter_id` is skipped for those roles) and the full KDS/floor plan, same as before.

### How "send to kitchen" works

No separate draft/staging step: submitting an order (cashier POS or waiter app) or adding
items to an already-open order *is* "send to kitchen" — items are inserted as `sent` with
`sent_to_kitchen_at = now()` directly (`POST /api/orders`, `POST /api/orders/[id]/items`),
so they appear on the KDS immediately. From there the existing `order_items.status` enum
(`sent → preparing → ready → served`, `voided` reachable from any non-terminal state,
migration 0001) drives everything: kitchen "bump" moves `sent→preparing→preparing→ready`
(`PATCH /api/kitchen/items/[itemId]`, kitchen/owner/manager only), and waiter/cashier mark
a `ready` item `served` once it's delivered (same endpoint, waiter/cashier/owner/manager).
The cashier-only quantity/void endpoint (`/api/orders/[id]/items/[itemId]`) is unchanged
and still voids from any state.

### Real-time layer

A custom server (`server.ts`) wraps Next's request handler in a plain `http.Server` so it
can also accept `/ws` upgrades (`ws` package); `npm run build` is untouched (`next build`),
only `dev`/`start` route through it. The upgrade handshake reads the session cookie and
calls `verifySession` (`src/lib/auth.ts`) — unauthenticated upgrades get `401` and are
dropped; every other upgrade (Next's own dev-mode HMR socket) is handed to
`app.getUpgradeHandler()` so `next dev`'s fast refresh keeps working. Authenticated sockets
are kept in an in-process registry (`src/lib/realtime.ts`, cached on `globalThis` like
`db.ts`'s pool, so dev hot-reload doesn't orphan connections); API routes call
`broadcast(locationId, event)` after each commit that changes order/table/session state,
scoped so a connection with a non-null `locationId` only receives its own location's
events (owner/roaming-manager connections have `locationId: null` and see everything — v1
is single-location anyway). The client hook `useRealtime` (`src/app/dashboard/use-realtime.ts`)
opens the socket with reconnect/backoff and every affected dashboard screen (orders list,
floor plan, waiter board, KDS) just refetches its own data on a relevant event — simplest
correct approach for a LAN-scale POS, at the cost of an extra round-trip per event rather
than client-side patching.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Order placed on the waiter app appears on the KDS within ~1s | `POST /api/orders` / `POST /api/orders/[id]/items` insert items as `sent` and `broadcast(..., {type: "order.created"/"order.updated"})`; `KdsBoard` (`src/app/dashboard/kitchen/kds-board.tsx`) refetches `/api/kitchen/tickets` on that event |
| Marking an item "ready" updates the waiter app and cashier view live | `PATCH /api/kitchen/items/[itemId]` broadcasts `order.item_status`; `TableOrderPanel` (waiter) and `OrdersList` (cashier) both listen via `useRealtime` and refetch |
| Multiple waiters/cashier/KDS open simultaneously never show stale/conflicting state | Every mutation (order create/update/void, item status, table status, session open/close/bill/merge) broadcasts before responding; every dashboard screen refetches from the DB (source of truth) on receipt, not from the WS payload itself |
| Kitchen sees which table/order-type each ticket belongs to at a glance | `GET /api/kitchen/tickets` joins `orders`/`dining_tables`; `KdsBoard` labels each ticket with the table name (dine-in) or queue label (`formatQueueLabel`, takeaway) |

Schema: `migrations/0005_waiter_kitchen_realtime.sql` (one supporting index only — the
status machine and `assigned_waiter_id` already existed from migrations 0001/0004). Unit
tests: `src/lib/order-item-status.test.ts` (status transitions, kitchen-bump vs.
mark-served permissions, ticket aging).
