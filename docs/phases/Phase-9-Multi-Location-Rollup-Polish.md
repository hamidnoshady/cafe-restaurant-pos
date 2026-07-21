# Phase 9 — Multi-Location Rollup & Polish

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–8
**Goal:** Multiple locations' local servers sync to a central view; overall system hardened and polished for real daily use.

---

## Scope

- Central aggregation database and sync job: each location's local server pushes closed shifts/reports to a central DB
- Owner dashboard: cross-location comparison views (sales, COGS, staff performance side by side)
- Permission edge-case review across all roles
- Performance pass: query optimization on reporting views, WebSocket load testing with realistic device counts
- General UI/UX polish pass across all four client apps

## Out of scope

- New features — this phase is integration, hardening, and polish of everything built in Phases 0–8

## Exit criteria

- Two (or more) test locations' data correctly rolls up into one central Owner view
- A location losing internet doesn't affect its local operation at all, and catches up the central sync automatically once reconnected
- No permission gaps found in a full role-by-role review (e.g. a Waiter cannot access ledger data, a Cashier cannot edit the Chart of Accounts)
- System performs acceptably under a realistic simulated load (your expected device count from Phase 4 Q5)

---

## Questions to answer before/during this phase

1. **Sync frequency** — how often should each location push to the central DB (real-time when online, hourly, end-of-shift only)?
2. **Central access** — who should be able to see the cross-location Owner dashboard — Owner only, or also location Managers seeing their own location plus limited comparison data?
3. **Conflict/failure handling** — if central sync fails for a period, should the location just keep queuing until it succeeds, with an alert to the Owner if the gap exceeds some threshold?
4. **Number of locations to plan/test for** — how many locations do you realistically expect within the first year, to size the load testing appropriately?
5. **Branding differences per location** — do different locations need different receipt branding/logos, or is it one consistent business identity across all?

---

## Decisions on Phase 9 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Sync frequency** — **every 5 minutes while online** (`ROLLUP_SYNC_INTERVAL_MS`, `src/lib/rollup.ts`; timer in `server.ts`), plus a manual «همگام‌سازی هم‌اکنون» button. Each push is an idempotent upsert of whole business days (today included), so central is near-live without any per-event streaming; hourly or end-of-shift would only save a trivial amount of traffic (a push is a handful of aggregate rows). There is deliberately no real-time channel between servers — the WebSocket layer (Phase 4) stays LAN-only.
2. **Central access** — **Owner only**, matching the pattern that every wider-scoped financial surface tightened one step (inventory/ledger/reports are Owner/Manager; cross-location comparison is Owner). `/dashboard/locations` and every `/api/rollup/*` management route are `requireRole("owner")`; a Manager sees their own location's reports (Phase 8) but no comparison data. Easy to widen later by adding roles to those guards.
3. **Conflict/failure handling** — **keep retrying, no queue to manage.** A failed push just records `lastError` (visible on `/dashboard/locations`) and the next tick re-pushes a window that starts `RESEND_OVERLAP_DAYS` (2) before the last *confirmed* day — because days upsert idempotently, "catch up after being offline a week" and "regular push" are the same code path (`runRollupPush`, `src/lib/rollup-service.ts`). There are no cross-server conflicts by construction: each location owns its rows outright (keyed by its registration), and a re-pushed day *replaces* that day wholesale. The "alert the Owner" half is the staleness flag: central marks a location «قطع همگام‌سازی» once it hasn't pushed for 24h (`STALE_AFTER_HOURS`), shown as a badge on the comparison and registry views — no push/email alert channel exists anywhere in the system yet, and this phase didn't build one.
4. **Number of locations to plan/test for** — **~5 locations in year one** as the planning number. With ~10 devices per location (Phase 4's "few dozen per location" ceiling), the realistic load is per-location anyway — each location's devices connect to their *own* local server, never to central; central only receives one small HTTP POST per location per 5 minutes. WebSocket load-tested at 50 and 100 concurrent sockets on one server (see performance pass below), comfortably past any single café's device count.
5. **Branding differences per location** — **one business identity.** Receipts already carry the shared business name plus the location's own address/phone (Phase 5 decision 4), which is exactly the per-location difference that matters; no logo field exists anywhere (also per Phase 5/8 decisions), so per-location logos would be new scope, not polish. Nothing was built here.

**Other decisions made while building:**

- **"Central" is this same app, not a separate service** — a central server is just another deployment of this codebase (its own Postgres, its own `npm start`), which keeps the on-site mini-PC story (Phase 0) intact: no cloud dependency, and any instance can act as location, central, or both. Migration `0009_rollup.sql` ships to every install; the rollup tables simply stay empty on a pure location.
- **Rollup rows deliberately do NOT reference `locations`** — a remote location exists in its own local DB, not in central's, so its central identity is its registration row (`rollup_locations`) created by the Owner. The pushed `source_location_id`/`timezone` are recorded as information, not FKs; the display name is the Owner's registered name, never overwritten by pushes.
- **Auth between servers is a per-location bearer token, hash-only at rest** — `POST /api/rollup/locations` generates `rlk_…` (`generateRollupToken`), stores only its sha-256 (`token_hash UNIQUE`), and shows the plaintext exactly once for the Owner to paste into the location's sync settings. Ingest looks the token up by hash and refuses inactive registrations, so deactivating a location revokes its token. `/api/rollup/ingest` is on the middleware public-path list because the caller is a server with no session cookie — it is the *only* route added there, and it authenticates every request itself.
- **What gets pushed is exactly what the Phase 8 views report** — `buildRollupPayload` reads `v_sales_by_day`, `v_shift_reconciliation` (payment-method breakdown), `v_ledger_by_account` (COGS account `5100` debits), `v_waste_summary`, and `v_staff_performance` — never raw transactional tables, so a location's central numbers can't disagree with its own reports. "Closed shifts/reports" concretely means completed orders bucketed per business day in the location's own timezone; there is still no shift/till entity (Phase 8 decision), so day × closing-staff remains the finest shift granularity, and `rollup_daily_staff` carries it.
- **Payload validation is pure and strict** — `validateRollupPayload` (`src/lib/rollup.ts`, unit-tested in `rollup.test.ts`) type-checks every field, enforces safe-integer Rial, real calendar days, de-duplication, and hard size caps before ingest touches the DB. Money may be negative (refund days); counts may not.

## Permission edge-case review (exit criterion 3)

Full role-by-role review of every API route and dashboard page, now **mechanized as a test** so it can't regress: `src/app/api/api-guards.test.ts` statically scans every `route.ts` and asserts (a) each one guards with `requireRole`/`requireManager` or is on a documented public allowlist (login/pin-login/logout, first-run bootstrap, token-authed rollup ingest, and the two `getSession`-self-guarding routes `auth/me`/`setup/state`); (b) back-office surfaces (`ledger/*`, `reports/*`, `staff`, `setup/*`, `rollup/*`) never grant cashier/waiter/kitchen; (c) inventory admin is Owner/Manager-only with `inventory/low-stock` as the single documented cashier-readable exception; (d) rollup management is Owner-only. Dashboard pages were reviewed separately — every role-gated page (`ledger`, `inventory`, `reports`, `menu`, `pos`, `kitchen`, `waiter`, `locations`, …) does a server-side `getSession()` + role redirect, so nav hiding is cosmetic, not the enforcement.

The review's specific criteria: a Waiter hitting any `/api/ledger/*` or `/dashboard/ledger` gets 403/redirected (`requireRole("owner", "manager")` on every ledger route); a Cashier hitting `/api/setup/accounts` (Chart of Accounts editing) gets 403 (`requireManager()`). **One real gap was found and fixed:** `GET /api/setup/menu/template` (the menu-import CSV template) was fully unauthenticated — harmless content, but now guarded with `requireManager()` like the rest of the wizard.

## Performance pass (exit criterion 4)

- **Reporting-view indexes** (`migrations/0009_rollup.sql`): every day-bucketed sales view filters `status = 'completed'` and buckets on `closed_at`, but `orders`' only time index was on `opened_at` — added partial index `idx_orders_location_closed`. `v_waste_summary` filters `stock_movements` by `type` — added `idx_stock_movements_location_type_time`.
- **WebSocket load test** (`scripts/ws-load-test.ts`): opens N authenticated sockets against a running server, then creates real takeaway orders through `POST /api/orders` and measures `order.created` fan-out to every socket. Measured on a production build (`npm start`), seeded DB:
  - **50 sockets × 10 rounds:** 500/500 deliveries, per-socket p50 **13ms**, full fan-out p50 **14ms** (one 468ms first-round cold-start outlier).
  - **100 sockets × 5 rounds:** 500/500 deliveries, p50 **15ms**, p95 **20ms**, max **21ms**.
  - Well under the phase's ~1s bar at 2–4× the realistic per-location device count (Phase 4 Q5), so the in-process `Set` registry (`src/lib/realtime.ts`) stays as-is.

## Polish pass

Deliberately targeted, not a rewrite: the dead «تنظیمات» sidebar placeholder (a permanently disabled `<span>` since Phase 0) is now a real link to `/setup` for Owner/Manager — the wizard was already revisitable and role-guarded, there was just no way back to it from the dashboard; new «شعبه‌ها» nav entry (Owner-only); the new locations page was verified rendered in a real browser (RTL layout, Jalali dates + Persian digits on sync timestamps, correct inline-start bar anchoring in the comparison chart) alongside the existing dashboard screens.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Two+ locations' data rolls up into one central Owner view | Verified end-to-end with three running servers (central + two locations on separate Postgres DBs): each location bootstrapped, sold paid orders, pushed via `POST /api/rollup/push`; central's `GET /api/rollup/overview` and `/dashboard/locations` showed both locations side by side with totals/order counts/payment splits/staff exactly matching each location's own orders, and a re-push changed nothing (idempotent) |
| A location losing internet keeps operating and catches up automatically | Orders/payments never touch the sync path (verified: order + payment succeed while central is unreachable); the failed push records `lastError` and the next push after reconnect covered the widened window and converged central's totals — `runRollupPush` + `computePushFromDay` (`src/lib/rollup-service.ts`, `src/lib/rollup.ts`) |
| No permission gaps in a full role-by-role review | `src/app/api/api-guards.test.ts` (111 assertions, runs in `npm test`/CI) + server-side page guards; the one found gap (`setup/menu/template`) fixed |
| Performs acceptably under realistic simulated load | `scripts/ws-load-test.ts` — 100 concurrent sockets, zero missed events, ≤21ms fan-out (details above) |

Schema: `migrations/0009_rollup.sql` (`rollup_locations`, `rollup_daily_summary`, `rollup_daily_staff`, two reporting indexes). Logic: `src/lib/rollup.ts` (pure, unit-tested) + `src/lib/rollup-service.ts` (DB/HTTP). Routes: `src/app/api/rollup/{ingest,locations,locations/[id],overview,config,push}`. UI: `/dashboard/locations` (`locations-manager.tsx`). Sync timer: `server.ts`. Unit tests: `src/lib/rollup.test.ts`, `src/app/api/api-guards.test.ts`.
