# Cafe/Restaurant POS

Persian-first (RTL, Jalali calendar, Toman display) point-of-sale system for cafes and restaurants. Built with Next.js + PostgreSQL.

Development is phased — see [docs/phases/README.md](docs/phases/README.md) for the phase index. **Current status: Phase 1 (Setup Wizard) implemented.**

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

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `start` | Production build / serve |
| `npm test` | Unit tests (Jalali, digits, money utilities) |
| `npm run db:migrate` | Apply pending SQL migrations from `migrations/` |
| `npm run db:seed` | Seed business, location, owner, sample cashier (idempotent) |

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
