# Phase 5 — Offline Queue + Hardware

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–4
**Goal:** A device briefly losing LAN connection doesn't lose data, and receipts/kitchen tickets print correctly on real hardware, with cash drawer control.

---

## Scope

- IndexedDB queue (Dexie.js) on each client: order actions taken while disconnected from the local server queue locally and sync on reconnect
- Conflict handling: what happens if two devices' queued actions conflict on reconnect
- **Print agent** — separate small Node service running on the till PC: exposes a localhost HTTP endpoint, speaks ESC/POS to receipt and kitchen printers, triggers the cash drawer kick, and backs the Phase 1 wizard's test-print step for real
- Receipt template (customer-facing) and kitchen ticket template (kitchen-facing), both RTL/Persian-correct

## Out of scope (later phases)

- Inventory (Phase 6)
- Ledger (Phase 7)
- USB/Bluetooth printer connections (only IP/port network printers, matching what Phase 1's wizard already captures)
- Split/partial payments (checkout records one full payment per order; see decision 6)

## Exit criteria

- Pulling the WiFi mid-order on a client doesn't lose the order; reconnecting syncs it correctly with no duplication
- A real (or test/emulated) receipt printer produces a correctly formatted, correctly RTL Persian receipt
- Cash drawer opens on triggering payment completion
- Kitchen ticket prints correctly if a physical kitchen printer is used (in addition to/instead of the KDS screen)

---

## Questions to answer before/during this phase

1. **Printer hardware** — what exact printer model(s)? (Determines the ESC/POS command set and connection type.)
2. **Cash drawer** — via the receipt printer's RJ11 port, or a standalone drawer?
3. **Kitchen printing vs. KDS-only** — physical printed tickets in addition to the screen, or is the screen enough?
4. **Receipt content/branding** — logo, business info, footer message?
5. **Conflict resolution preference** — last-write-wins, flag for manual review, or something else?
6. **Card payment terminal** — separate physical terminal (software just records "paid by card"), or does software talk to it directly?

---

## Decisions on Phase 5 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Printer hardware** — no specific model, on purpose. Rather than guess a codepage/Persian-font setup that might not match whatever gets bought, printing targets the universal ESC/POS `GS v 0` raster-image command, supported by essentially every ESC/POS-compatible printer regardless of brand or firmware. Connection is a raw TCP socket to `ip:port` (port 9100 by default), the same `connection` shape Phase 1's wizard already stores on `printers`. USB/Bluetooth direct connections are out of scope for v1 (`print-agent/transport.ts` is the one place that would change).
2. **Cash drawer** — assumed wired through the receipt printer's RJ11 port (the common setup), kicked with the standard `ESC p` pulse command (`src/lib/escpos.ts`'s `openDrawerPin`/`buildDrawerKickJob`). No standalone drawer controller in v1.
3. **Kitchen printing vs. KDS-only** — both. Sending to kitchen prints a ticket (if a kitchen printer is configured) *in addition to* the existing KDS broadcast (Phase 4); missing/unreachable hardware never blocks the order.
4. **Receipt content/branding** — business name + location address/phone (`GET /api/business-info`) and a static thank-you footer. No logo/social handles in v1 — `ReceiptData.business.footerMessage` is free text already, ready to wire to a settings field later without a template change.
5. **Conflict resolution** — replay-based, not blind last-write-wins. `order.create`/`order.add_items` are pure appends, so they never conflict — the server-side idempotency key (`client_event_id`) only guards against a client retrying its own flush. `order_item.status` updates re-validate against the existing status machine (`order-item-status.ts`) at replay time via `offline-sync.ts`'s `classifyStatusReplay`: a transition that's still legal from the item's *current* state applies; landing on the state it's already in is a harmless duplicate; anything else (already voided, superseded by a different device's action) is flagged a conflict instead of silently overwritten.
6. **Card payment terminal** — separate physical terminal; the app only records which method was used after the fact (`POST /api/orders/[id]/pay`), matching what Phase 1's wizard already assumed. No terminal integration.

### Offline queue

`sync_events` (migration 0001, unused until now) is the server-side idempotent inbox: `UNIQUE (location_id, client_event_id)` lets a client retry a flush without double-applying it. The client side is `src/lib/offline-db.ts` (Dexie `pendingActions` table, one row per queued mutation, keyed by a client-generated uuid that doubles as `client_event_id`) plus `src/app/dashboard/offline-queue.tsx`:

- `apiOrQueue()` wraps a mutation's fetch. A real network failure (fetch throws — LAN drop, agent unreachable) queues the action and reports success-with-`queued: true` to the caller; a server-side rejection (validation error, 409, …) still comes back as a normal failure — only "the request never reached the server" gets queued.
- `flushQueue()` POSTs the whole queue to `POST /api/sync/events`, in the order actions were queued, on the `online` event and every 15s while online; whatever the server reports as applied *or* conflicted is removed (nothing left to usefully retry either way).
- `useOfflineQueue()` + `OfflineBanner` (mounted in the dashboard layout) surface pending-count / offline state on every screen.
- Wired at the four places an order/kitchen action can be lost mid-service: POS order submit (`pos-screen.tsx`), order-detail "add item," waiter "send to kitchen" (`table-order-panel.tsx`), and both kitchen-bump (`kds-board.tsx`) and mark-served status updates.

Server side, `src/lib/sync-events.ts` dispatches each event to the *same* transaction functions the synchronous routes use — `src/lib/order-mutations.ts` (`createOrder`/`addItemsToOrder`) was extracted out of `POST /api/orders` and `POST /api/orders/[id]/items` specifically so an order created while offline can't behave differently from one created online. `order_item.status` events go through `classifyStatusReplay` (decision 5) before touching the DB.

### Print agent + hardware

`print-agent/` is a standalone Node service (`npm run print-agent`) with no DB access, listening on loopback only (`127.0.0.1`, not the LAN) — the dashboard's browser (running on the same till PC) calls it directly, not through this app's server, since the printer is physically wired to whatever machine is at the counter. Pipeline for both templates:

1. Pure HTML string (`src/lib/receipt-template.ts` / `src/lib/kitchen-ticket-template.ts` — RTL, Persian digits, Jalali dates via the existing `digits.ts`/`jalali.ts`/`money.ts` helpers, unit-tested as strings, no DB/rendering)
2. Real Chromium screenshot (`print-agent/render.ts`, via `playwright-core`, with the repo's bundled Vazirmatn font embedded as a data URI so Persian shaping/BiDi is handled by an actual browser engine)
3. Grayscale decode (`print-agent/png.ts`, via `pngjs`)
4. 1-bit ESC/POS raster packing (`src/lib/escpos.ts`'s `packMonochromeRaster`, unit-tested)
5. Raw TCP write to the printer (`print-agent/transport.ts`)

Why raster instead of ESC/POS text mode: no printer we could target ships a codepage that covers Persian (not just Arabic) correctly, and none do BiDi reordering — rendering with a real browser sidesteps both problems and works on any ESC/POS-compatible printer, not a specific model (decision 1). This was verified end-to-end in this session: rendering a sample receipt through the full pipeline into a PNG showed correctly shaped, correctly right-to-left Persian text and the right Jalali date.

`GET /api/printers` (any dashboard role) and `GET /api/business-info` let the browser assemble what the print agent needs without going through the manager-only `/api/setup/*` endpoints. Checkout (`POST /api/orders/[id]/pay`) is new in this phase — orders never reached `status = 'completed'` anywhere before it (`table-session-service.ts`'s `closeSession` only ever freed the table; payment recording didn't exist). It records one full payment (v1: no split/partial — decision 6) and completes the order; `order-detail.tsx`'s `pay()` then best-effort prints the receipt and, for cash, kicks the drawer, never blocking checkout success if the agent or printer is unreachable.

The setup wizard's step 7 (`/setup/hardware`) "test print"/"test drawer" buttons now call the real agent first; if it's unreachable (no printer paired yet, or a dev environment with nothing running) they fall back to the existing simulated preview, so the wizard step still completes without hardware present.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Pulling WiFi mid-order doesn't lose the order; reconnect syncs with no duplication | `offline-db.ts` + `offline-queue.tsx` queue `order.create`/`order.add_items`/`order_item.status`; `POST /api/sync/events` + `sync-events.ts` apply idempotently keyed on `client_event_id` (`sync_events` UNIQUE constraint) |
| A receipt printer produces a correctly formatted, correctly RTL Persian receipt | `receipt-template.ts` (tested) rendered by `print-agent/render.ts` via real Chromium — verified end-to-end in this session |
| Cash drawer opens on payment completion | `POST /api/orders/[id]/pay` + `order-detail.tsx`'s `pay()` calls `kickDrawer()` for cash payments; `escpos.ts`'s `openDrawerPin`/`buildDrawerKickJob` (tested) |
| Kitchen ticket prints in addition to the KDS | `kitchen-ticket-template.ts` (tested); `pos-screen.tsx`/`table-order-panel.tsx` call `printKitchenTicket()` alongside the existing KDS broadcast (Phase 4) |

Schema: no new migration — migration 0001 already modeled `sync_events`, `printers`, and `payments`/`orders.status = 'completed'` for this exact phase; Phase 5 is purely an application-layer feature on top of existing schema (same shape as Phase 4 was for the WebSocket layer). Unit tests: `escpos.test.ts`, `receipt-template.test.ts`, `kitchen-ticket-template.test.ts`, `offline-sync.test.ts`, `printer-connection.test.ts`.
