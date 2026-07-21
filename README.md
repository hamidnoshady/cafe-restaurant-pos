# Cafe/Restaurant POS

Persian-first (RTL, Jalali calendar, Toman display) point-of-sale system for cafes and restaurants. Built with Next.js + PostgreSQL.

Development is phased — see [docs/phases/README.md](docs/phases/README.md) for the phase index. **Current status: Phase 4 (Waiter + Kitchen Apps, Real-Time Sync) implemented.**

## Stack

- **Next.js 15** (App Router, TypeScript) — single app, role-based routes
- **PostgreSQL 16** — full schema for all phases migrated up front
- **Tailwind CSS 4** — logical properties for RTL-safe layout
- **Vazirmatn** variable font (bundled locally, works offline)
- Auth: **JWT session cookie** (Owner/Manager email+password) + **4-digit PIN quick-login** (Cashier/Waiter/Kitchen)

## Getting started

```bash
# 1. Start Postgres (Docker)
docker compose up -d

# 2. Configure environment
cp .env.example .env    # defaults match docker-compose

# 3. Install, migrate
npm install
npm run db:migrate

# 4. Run
npm run dev             # http://localhost:3000
```

### First run — the Setup Wizard (Phase 1)

On a **completely empty database**, opening the app sends you to `/welcome`, which
creates the business + first Owner account, then walks you through an 8-step guided
wizard (`/setup/*`) — no manual DB edits needed:

1. **Business info** — name, location, currency/language defaults
2. **Chart of accounts** — editable pre-built F&B template
3. **Inventory costing** — FIFO vs Weighted Average (locked after the first transaction)
4. **Tax** — default VAT rate + per-category rates
5. **Roles & users** — Manager (email/password) and Cashier/Waiter/Kitchen (4-digit PIN)
6. **Menu** — manual entry or CSV/Excel import (downloadable template)
7. **Hardware** — printer pairing + test print (stubbed until Phase 5)
8. **Opening balances** — opening inventory count + balanced opening journal entry

Until the wizard is completed, Owner/Manager logins are routed into it; the dashboard
shows a "resume setup" banner.

### Optional: seed a demo business instead

To skip the wizard and get a ready-to-log-in demo:

```bash
npm run db:seed         # creates owner@example.com / owner1234 and a cashier with PIN 1234
```

Log in at `/login`:

- **Owner/Manager tab:** `owner@example.com` / `owner1234` (override via `SEED_OWNER_*` env vars before seeding)
- **PIN tab:** `1234` (sample cashier)

The seed also creates 3 sample dining tables and a small demo menu (2 categories, 3 items,
1 modifier group) so the cashier POS screen has something to sell right away.

### Menu management & the cashier POS (Phase 2)

- **`/dashboard/menu`** (Owner/Manager) — CRUD for categories, items, modifier groups and
  modifiers, plus attaching modifier groups to items. Independent of the wizard's initial
  import — ongoing management.
- **`/dashboard/pos`** (Owner/Manager/Cashier) — the cashier screen: category tabs → item
  grid → cart with per-item modifiers, quantity, and an order-level discount (percent or
  fixed amount). Choose dine-in (pick a table from the stub list) or takeaway (gets a
  queue number, e.g. `T-42`), then submit.
- **`/dashboard/orders`** — open orders list and detail view; while an order is `open` you
  can add items, change quantity, void an item, edit the discount, or void the whole order.

### Waiter app & Kitchen Display (Phase 4)

Orders sync live over a WebSocket (`/ws`, see `server.ts` + `src/lib/realtime.ts`) — no
polling. Submitting an order (from the cashier POS or the waiter app) *is* "send to
kitchen": its items land on the KDS as `sent` immediately.

- **`/dashboard/waiter`** (Waiter, + Owner/Manager "all tables" overview) — only the
  sections assigned to the logged-in waiter (`floor_sections.assigned_waiter_id`, set on
  the floor plan). Tap a seated table to add items to its open order/round, see each
  item's live kitchen status, and mark a `ready` item `served` once it's delivered.
- **`/dashboard/kitchen`** (Kitchen, + Owner/Manager) — the KDS: one ticket per table
  (grouping every round on that table's open session) or per takeaway order, oldest
  first. Tickets outstanding ≥ 10 minutes (`DEFAULT_TICKET_AGING_MINUTES`,
  `src/lib/order-item-status.ts`) flag red. "Bump" moves an item `sent → preparing →
  ready`.
- Every open dashboard screen (cashier orders list, floor plan, waiter board, KDS)
  refetches on the relevant WebSocket event, so no two screens ever show conflicting
  order/table state.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Custom dev server (`server.ts`, via `tsx watch`) — Next.js + the `/ws` WebSocket sync channel |
| `npm run build` | Production build (plain `next build`; no server needed to build) |
| `npm start` | Custom production server (`server.ts`) — same as `dev`, without hot reload |
| `npm test` | Unit tests (Jalali, digits, money, order totals, kitchen ticket status, …) |
| `npm run db:migrate` | Apply pending SQL migrations from `migrations/` |
| `npm run db:seed` | Seed business, location, owner, sample cashier (idempotent) |
| `npx tsx scripts/ws-load-test.ts` | WebSocket load test against a running, seeded server (Phase 9 — see the script header for env knobs) |

## Conventions (important)

- **Money** is stored as `BIGINT` **Rial** (smallest unit) everywhere — DB, API, calculations. Formatting as Toman with Persian digits happens only at display time (`src/lib/money.ts`).
- **Dates** are stored as ISO/Gregorian `timestamptz` everywhere. Jalali conversion happens only at display time (`src/lib/jalali.ts`).
- **Digits** are stored as Latin numerals; Persian digits are display-only (`src/lib/digits.ts`).
- **Multi-location:** every tenant-scoped table carries `location_id` (business-scoped tables like `users`, `accounts`, `customers` carry `business_id` and a nullable `location_id`), even though v1 may run a single location.
- Migrations are forward-only numbered SQL files in `migrations/`, applied by `scripts/migrate.ts` (tracked in `schema_migrations`).

## Decisions on Phase 0 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Dev Postgres** — Docker Compose (`postgres:16-alpine`). The same compose file works on the eventual on-site mini PC; nothing assumes a cloud host.
2. **Repo structure** — single Next.js app with role-based routes (`/dashboard`, later `/cashier`, `/waiter`, `/kds`). A monorepo split is deferred until a client genuinely needs a separate deployable; nothing so far justifies the overhead.
3. **Auth details** — Owner/Manager JWT sessions last **12h** (configurable via `SESSION_HOURS`). No 2FA in v1; the schema doesn't block adding it later.
4. **PIN login** — **4 digits**, unique **per location** (PINs are bcrypt-hashed; uniqueness is enforced at PIN-assignment time in the app layer, since hashes can't carry a DB unique constraint).
5. **Font** — Vazirmatn (bundled woff2, SIL OFL) as primary, with `Tahoma, Segoe UI, sans-serif` fallback for Latin text/SKUs.
6. **Versions** — Node ≥ 20 (developed on 22), PostgreSQL 16. The schema uses PG15+ features (`UNIQUE NULLS NOT DISTINCT`).

## Phase 0 exit criteria → where satisfied

| Criterion | Where |
|---|---|
| Seed one Owner and log in | `npm run db:seed` + `/login` |
| Empty RTL dashboard shell | `/dashboard` (`dir="rtl"`, Vazirmatn, logical properties) |
| Migrations run clean on empty Postgres | `migrations/0001_foundation.sql` via `npm run db:migrate` |
| ISO → Jalali → back with no drift | `src/lib/jalali.test.ts` (round-trips every day 2020–2030) |
| Integer rial displays as Toman | `src/lib/money.test.ts` |
