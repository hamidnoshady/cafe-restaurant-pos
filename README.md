# Cafe/Restaurant POS

Persian-first (RTL, Jalali calendar, Toman display) point-of-sale system for cafes and restaurants. Built with Next.js + PostgreSQL.

Development is phased — see [docs/phases/README.md](docs/phases/README.md) for the phase index. **Current status: all 18 numbered phases implemented; Phase 18b is complete for its documented existing-model scope, and Phase 19 is in progress with its Waves 1–2 public-API foundation and core data API** — a single-business POS (Phases 0–11: menu/POS, tables, waiter/kitchen real-time sync, offline queue, inventory, ledger, reporting, multi-location rollup, backups, delivery) turned into a multi-business platform (Phases 12–17: tenant isolation via RLS, teams & permissions, per-business branches, a super-admin console, a real accounting suite, and entitlement/rate-limit hardening), then added platform-owned, metered AI credits and subscriptions (Phase 18). All five Phase 18b waves are shipped. Capabilities that require a new expiry, delivery-zone, staff-shift, ETA, credit-limit, or promotion data model remain explicitly deferred in the Phase 18b document rather than being approximated or silently omitted.

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

A standalone desktop install gets one extra optional step between hardware and opening —
**backup destination**, with a real OS folder dialog — and `/welcome` there first asks
whether to set up locally or pair with an existing online business
([docs/standalone-desktop-app.md](docs/standalone-desktop-app.md#first-run--local-setup-or-pairing)).

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
  (grouping every round on that table's open session) or per takeaway order. Its deterministic
  next-ticket queue places overdue tickets first, then `sent`, `preparing`, and `ready`, with
  oldest-first ties—no AI call or credit charge. Tickets outstanding ≥ 10 minutes
  (`DEFAULT_TICKET_AGING_MINUTES`, `src/lib/order-item-status.ts`) flag red. "Bump" moves an
  item `sent → preparing → ready`.
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
| `npm run db:app-role` | Provision the unprivileged DB role the app should connect as (Phase 12 — see Multi-business below) |
| `npm run test:db` | Database integration tests (`integration/`), against a real Postgres |
| `npm run db:seed` | Seed business, location, owner, sample cashier (idempotent) |
| `npm run db:restore` | Restore a backup artifact — dry-runs into a scratch DB first (Phase 10, see [docs/backup-restore.md](docs/backup-restore.md)) |
| `npm run db:restore-tenant` | Restore a per-tenant export SQL file into a clean, migrated database — dry-runs by default (Phase 17, see [docs/backup-restore.md](docs/backup-restore.md)) |
| `npx tsx scripts/ws-load-test.ts` | WebSocket load test against a running, seeded server (Phase 9 — see the script header for env knobs) |
| `npx tsx scripts/order-perf-benchmark.ts` | Order-creation and payment/inventory-consumption latency against a running, seeded server (Phase 17 — see the script header for env knobs) |

### Backups (Phase 10)

`/dashboard/backup` (Owner sets schedule/retention/cloud; Owner+Manager can
«پشتیبان‌گیری هم‌اکنون» and see run history). Scheduled `pg_dump` of the whole
local DB to the Owner-chosen destination folder — falling back to `BACKUP_DIR`
when that's left empty, which is every install that predates the desktop app —
plus an optional `BACKUP_SECONDARY_DIR` (USB/NAS), and an AES-256-GCM-encrypted
copy uploaded to any S3-compatible storage. A local-only install has no cloud
half at all (see "Deployment mode" below). Failed/overdue backups raise a red
banner on the Owner dashboard. Restore
(always dry-run first): `npm run db:restore` — full runbook in
[docs/backup-restore.md](docs/backup-restore.md). The host needs
`postgresql-client` ≥ 16 (`pg_dump`/`pg_restore`).

**Per-tenant export & restore (Phase 17)** — the backup above is the whole
physical database; a single business's own data (Owner-only, same page) is a
separate download: `GET /api/backup/export?format=sql|xlsx`, restorable SQL
or a per-table Excel workbook, filtered by ordinary RLS
(`src/lib/tenant-export.ts`). Restore the SQL file into a clean, migrated
database with `npm run db:restore-tenant` — full runbook, including why it
doesn't need a scratch database, in [docs/backup-restore.md](docs/backup-restore.md).

**Moving an install to another server** — the same dump plus a
drain/verify/cutover procedure, with one recipe per hosting platform (Runflare,
plain VPS, Komodo, managed-Postgres PaaS, on-site machine):
[docs/server-migration.md](docs/server-migration.md).

### AI assistant (دستیار هوشمند)

A floating assistant (bottom-left launcher) built with the shadcn UI kit, in two
modes:

- **Wizard mode** — mounted on every `/setup/*` step. You describe the
  cafe/restaurant in chat and the agent gathers the missing details, then
  proposes a fully-filled payload for that step. Nothing is written until you
  press **«تأیید و اجرا»** (human-in-the-loop); on apply it POSTs to the existing
  `/api/setup/*` endpoint and jumps to the next incomplete step. The wizard pages
  themselves are unchanged — the assistant sits on top of them.
- **Dashboard mode** — mounted for Owner/Manager. It runs the standard reports
  (`run_report`/`list_reports`), inspects setup state, answers questions, and can
  perform allowed "jobs" (e.g. add a menu category/item) — again only through the
  same confirmed-action gate.

The agent's mutations are restricted to a fixed allowlist (`ACTION_CATALOG` in
`src/lib/ai.ts`) that maps each proposed action to an already role-guarded
endpoint, so it can never call an arbitrary URL. Read tools run server-side and
never mutate data.

**Wave 5 interaction safeguards.** Before an assistant request reaches a provider,
the chat panel asks for confirmation against a conservative, visible credit-cost
estimate (including the existing maximum reservation). Provider text is relayed
incrementally to the panel; tool rounds and action confirmation remain server-side.
Suggested prompt chips appear on open, and **«توضیح این عدد»** on eligible report
previews/pinned widgets opens the assistant with the visible report context
pre-filled. Every proposed action is recorded in a tenant-scoped audit trail with
the prompting user, proposed payload summary, and applied/failed/dismissed outcome,
available to Owner/Manager at `/dashboard/ai`. No real WhatsApp, Telegram, voice,
SMS, or automatic customer-message channel is introduced.

**Platform-owned providers and billing.** Two OpenAI-compatible providers are supported — **OpenRouter** and
**ArvanCloud AI** — through one platform-owned connection configured only at
`/platform/ai`. Businesses never enter or receive a provider key: `/dashboard/ai`
shows their balance, subscription, usage history, and package-based top-up request
flow. Each assistant turn atomically reserves a configured maximum, settles its
actual provider token usage, and refunds unused credit; a business with insufficient
credit is blocked before a provider request. The platform console also owns package
pricing, subscription grants, pending request approval, feature overrides and
cross-business usage. Deployment-level env variables remain bootstrap fallbacks;
see `.env.example`.

## On-site deployment (café laptop / mini PC)

A café can run the POS entirely on its own LAN — no internet dependency for
day-to-day operation — instead of only on the shared VPS. Two installers
exist; pick whichever fits:

### Standalone installer (no Docker)

The simplest possible install: one `.exe`, no Docker Desktop, no `docker
login`, no manual database setup at all. It bundles Electron (app window +
Node runtime) and a real PostgreSQL 16 (`embedded-postgres` — the actual
Postgres binary, run as a plain background process, not a container) around
the app's own unmodified `server.ts` and migrations. See
[docs/standalone-desktop-app.md](docs/standalone-desktop-app.md) — including
its current limitations (no self-update yet, not yet validated on a real
Windows machine).

Either way the install is a **site**, not the central server: set
`DEPLOYMENT_ROLE=site` (Phase 23) so the Server Sync tab shows the central
server's address as derived read-only text — pairing already recorded it —
rather than asking the operator to type it. The VPS sets
`DEPLOYMENT_ROLE=central`, where the connection form is replaced by the paired
site's status and `PUT /api/server-sync/config` refuses outright. Unset, the
role is inferred (`central` if `REMOTE_SYNC_TOKEN` or `POS_DOMAIN` is set) and
logged at startup.

The shared sync token is generated by the product now — a grouped, checksummed
`POS1-…` string from the Server Sync tab's "generate token" button, validated
identically on both sides. Tokens created before that (64-character hex) keep
working and are flagged for rotation.

### Docker-based installer (mature, self-updating)

More one-time setup, but proven in production:

- **`docker-compose.local.yml`** runs a prebuilt image pulled from GHCR (not
  built on the laptop) plus its own Postgres, published on the LAN so waiter
  phones, the kitchen display and the cashier can all reach it at
  `http://<laptop-lan-ip>:3000`.
- **`windows/Install-CafePOS.ps1`** turns it into ordinary software for
  non-technical staff — a desktop icon, Start-menu entry, and auto-launch at
  login, with no Docker or terminal exposure afterwards. See
  [docs/windows-desktop-app.md](docs/windows-desktop-app.md).
- **Bidirectional server-sync** ([docs/server-sync.md](docs/server-sync.md))
  keeps the laptop and the VPS in sync, so the café keeps working through an
  internet outage and catches up automatically on reconnect.
- **Self-update** ([docs/server-sync.md](docs/server-sync.md) "Self-update") —
  the laptop checks for a newer version on every boot, over that same
  authenticated sync pairing, and updates itself automatically. No registry
  credential is ever distributed to a laptop: the VPS mints a short-lived
  (~1h), read-only GHCR pull token per request via a GitHub App, and only for
  a business that's already paired — a leaked one expires on its own within
  the hour.

## Conventions (important)

- **Money** is stored as `BIGINT` **Rial** (smallest unit) everywhere — DB, API, calculations. Formatting as Toman with Persian digits happens only at display time (`src/lib/money.ts`).
- **Dates** are stored as ISO/Gregorian `timestamptz` everywhere. Jalali conversion happens only at display time (`src/lib/jalali.ts`).
- **Digits** are stored as Latin numerals; Persian digits are display-only (`src/lib/digits.ts`).
- **Multi-location:** every tenant-scoped table carries `location_id` (business-scoped tables like `users`, `accounts`, `customers` carry `business_id` and a nullable `location_id`). Since Phase 14 a business may have several active branches; `resolveActiveLocation` (`src/lib/setup-state.ts`) is what every route resolves the caller's current branch through, validated against their branch assignment (`src/lib/location-access.ts`).
- **Multi-business:** `businesses` is the tenant, and isolation between tenants is enforced by Postgres row-level security — see below.
- Migrations are forward-only numbered SQL files in `migrations/`, applied by `scripts/migrate.ts` (tracked in `schema_migrations`).

## Multi-business tenancy (Phase 12, Phase 23)

One deployment can host many businesses. Three things are worth knowing before working on
anything that touches the database — or the browser.

**Isolation is enforced by the database, not by query authors.** Every tenant-scoped table
has a row-level security policy keyed on the `app.business_id` session setting
(`migrations/0021_row_level_security.sql`). `src/lib/db.ts` applies that setting on every
connection checkout from the tenant context (`src/lib/tenant-context.ts`), which
`getSession()` establishes once per request. So a handler that forgets a `WHERE business_id
= …` gets *fewer* rows, never another tenant's. With no context at all, tenant tables read
as empty — it fails closed.

A handful of operations legitimately cross tenants and go through `withoutTenantScope()`,
each because it has to resolve *which* tenant a request is for before that tenant can be
known any other way: login, platform administration, server-sync and public-API bearer
auth, a narrow write to the global identity table, an employee-session re-check, and
desktop pairing, and host resolution. `src/lib/db.ts`'s doc comment on the function is the
authoritative list — grep for the function to audit the call sites against it.

**Since Phase 23, origin is the second boundary.** Row-level security keeps one tenant's rows
away from another's queries, but it says nothing about the browser: before Phase 23 every
business on a deployment was served from a single origin and told apart by a `/{slug}/dashboard`
path prefix the app itself applied. That means one cookie jar, one `localStorage`, one service
worker, one CSP/CORS boundary shared by every tenant — and origin is the browser's only real
isolation primitive.

Each business is served from `{subdomain}.$ROOT_DOMAIN`, the super-admin console from
`admin.$ROOT_DOMAIN`, and the bare domain is a "which business?" router. The session cookie
deliberately carries **no `domain` attribute** (`sessionCookieOptions` in `src/lib/auth-edge.ts`),
so it is host-scoped and never sent to another business's origin; `src/middleware.ts` additionally
compares the request's host label against the session's own `businessSubdomain` claim and fails
closed on any mismatch. Setting a cookie `domain` would silently undo all of it, which is why
that omission carries a comment saying so.

**The origin is the only tenancy in a URL.** The `/{slug}/dashboard` path prefix is gone: the
dashboard is served at `/dashboard` on the business's own host, nothing generates a prefixed URL
any more, and an old prefixed bookmark 301s to the host that serves that business today. Each
business's subdomain is **typed in English by a super-admin** in `/platform` when the business is
created — it is never transliterated from the Persian business name — and can be renamed later,
with the old host kept as a redirecting alias.

**`ROOT_DOMAIN` is the switch**: setting it turns host-based tenancy on, and an install without
one (the desktop app, a single-café laptop) simply serves `/dashboard` unscoped. The root may
itself be a subdomain — `ROOT_DOMAIN=ac.eshobe.com` puts businesses at `biz1.ac.eshobe.com` and
the console at `admin.ac.eshobe.com` — in which case the wildcard certificate has to be
`*.ac.eshobe.com`, since one for `*.eshobe.com` does not cover a name a level deeper. ACME will
not issue `*.$ROOT_DOMAIN` over an HTTP-01 challenge, so the Traefik certresolver must use DNS-01;
`SUBDOMAIN_ROUTING=off` is the escape hatch for a deployment whose certificate is not issuing yet.
`WEBAUTHN_RP_ID` defaults to `ROOT_DOMAIN` for the same reason biometric login needs it to: a
browser only accepts an RP ID that is a registrable suffix of the page's origin. See
[docs/phases/Phase-23-Subdomain-Tenancy.md](docs/phases/Phase-23-Subdomain-Tenancy.md).

**The app's database role must not be a superuser.** Superusers and `BYPASSRLS` roles ignore
row-level security entirely, which would make every policy a silent no-op. The `pos` role
that `docker-compose.yml` creates *is* a superuser — fine for local single-business work,
not for a hosted deployment:

```bash
APP_DB_PASSWORD=$(openssl rand -hex 32) npm run db:app-role
# then point DATABASE_URL at postgres://pos_app:<that password>@…
```

Migrations keep running as the owner. `server.ts` refuses to start in production when the
configured role can bypass RLS, and warns in development.
`integration/tenant-isolation.integration.test.ts` provisions its own unprivileged role, so
the policies are proven in CI regardless of how the local database is set up.

**Connection pool size** (`DB_POOL_MAX`, default 20). A transaction (order creation, payment
+ inventory consumption) pins one connection for its full lifetime, so the right ceiling
scales with how many businesses' concurrent write transactions one deployment expects to
serve — several busy cafés sharing one host need more headroom than a single one. See
`src/lib/pool-config.ts`.

**Docker deployments (`docker-entrypoint.sh`) do this for you.** Every shipped compose file
(`docker-compose.komodo.yml`, `docker-compose.local.yml`, `docker-compose.srv1.yml`) hands the
app container one Postgres superuser — the same one that runs migrations — because asking
every operator to hand-edit their stack's environment to carry a second role and password
isn't worth the friction. The entrypoint migrates with that connection as usual, then runs
`scripts/derive-runtime-database-url.ts`, which provisions `pos_app` from it (reusing its
password — nothing new to configure) and launches the server with *that* connection instead.
An already-restricted `DATABASE_URL`, or an explicit `RUNTIME_DATABASE_URL`, are both left
alone. This is why the compose files' `DATABASE_URL` staying a superuser is fine, on purpose —
it never reaches the running server process.

**Identity vs membership.** `platform_users` is the login identity (globally unique email);
a row in `users` is that person's *membership* of one business, carrying their role, PIN,
permission overrides and default branch. One person can hold several memberships and switch
between them (`/api/auth/switch-business`). PIN-only staff have no platform identity and
belong to exactly one business.

**Deployment mode.** `settings['deployment.mode']` records whether an install is `local`
(standalone desktop, no online platform) or `connected`. **An absent setting reads as
`connected`**, so every deployment that predates this feature — every VPS, every
already-paired laptop — behaves exactly as it did, with no backfill migration.
`isLocalOnly(businessId)` in `src/lib/deployment-mode.ts` is the one place to ask. A local
install turns off the three platform-dependent features (`ai_assistant`, `multi_location`,
`offline_mode`) and has no cloud backup; see
[docs/standalone-desktop-app.md](docs/standalone-desktop-app.md#first-run--local-setup-or-pairing)
for the first-run flow and how a desktop install pairs with an existing online business.

**Dashboard URL carries the business's slug.** The browser sees `/{slug}/dashboard/...` —
the business's slug (its stable, human-readable "english name", set at signup/provisioning
and immutable after) — while every page still lives at `/dashboard/...` underneath.
`src/middleware.ts` handles the whole thing: the bare form redirects to the slugged one (so
every existing internal link still works), and the slugged form is rewritten back to the real
route, validating the slug against the caller's own session and redirecting to the correct one
otherwise. The slug rides on the session JWT (`businessSlug`, minted at
login/switch/impersonate — see `src/lib/auth-edge.ts`) specifically so this needs no database
lookup in the Edge runtime; a token from before that field existed just serves the dashboard
unprefixed until the next login re-mints one. `RESERVED_SLUGS` in `src/lib/slug.ts` keeps a
business from ever being assigned a slug that collides with a top-level route (`dashboard`,
`api`, `login`, …).

## Super-Admin Console (Phase 15)

A platform operator administers every business on the deployment from a **separate console at
`/platform`** — provisioning, entitlements, health and support — without ever being a member of any
business. It is a distinct auth realm: `platform_admins` log in against their own JWT cookie
(`pos_platform_session`, path-scoped to `/platform`), and `src/middleware.ts` keeps the two realms
disjoint — a tenant session can't reach `/platform`, and a platform session can't be used against a
tenant API route.

Mint the first platform admin (support / engineer / owner role):

```bash
npm run db:platform-admin
```

The console (dark chrome, deliberately unlike the tenant dashboard's light theme) covers:

- **Businesses** — provision a working business end-to-end (owner + chart of accounts + first
  branch, the owner logs straight in), then suspend / reactivate / archive / reset / hard-delete.
  Suspending blocks members at login and at the API guard without deleting anything. Reset and
  hard-delete are both immediate and irreversible, with no archive step or grace window — the only
  safety net is the owner-only capability plus typing the fixed confirmation phrase (`delete-me`,
  `DESTRUCTIVE_CONFIRMATION_PHRASE` in `src/lib/platform-admin.ts`) into the console.
- **Plans & feature flags** — assign a plan or override a single `business_features` flag per
  business.
- **Support / impersonation** — enter a business read-only or full-access; impossible without an
  audit record naming the admin, the business and the time window. Every impersonated action is
  tagged in `platform_audit_log`, viewable in the console's **Audit** tab.
- **System** — migration status, RLS effectiveness, pool health, per-business backups.
- **Updates** — the S3-compatible bucket the standalone desktop installer's self-update checks
  (owner-only to configure — it holds a real secret key), plus which businesses' on-site
  installs are currently up to date vs behind (any admin can view). See
  [docs/standalone-desktop-app.md](docs/standalone-desktop-app.md). This is the general pattern
  for cross-business client supervision: it belongs in this console, not a per-business
  dashboard — see `CLAUDE.md`.
- **Admins** — the platform admin roster (owner-only). Capabilities are gated by role
  (`src/lib/platform-admin.ts`): support = read + read-only impersonation; engineer adds feature
  writes, suspend/reactivate and impersonation revoke; owner adds full impersonation,
  provision/archive/delete and admin management.

## Accounting Suite (Phase 16)

The Phase 7 double-entry ledger (chart of accounts, auto-posting for payments/purchases/COGS/
waste, trial balance) becomes a suite an accountant can actually close a year on, all under
`/dashboard/ledger` and `/dashboard/reports` (Owner/Manager + the `accountant` role):

- **Fiscal years & periods** — soft-close and hard-lock a period so nothing posts into it, with
  a controlled reopen; year-end closing entries roll P&L into retained earnings.
- **Financial statements** — P&L, balance sheet, and cash flow, each with period comparison and
  drill-down to the journal entries behind any figure.
- **AR/AP subledgers** — customer/supplier balances, invoices/bills, receipts/payments, aging
  buckets, statements. The customer *directory* itself — create, edit, archive/delete, address
  and notes — is a standalone page at `/dashboard/customers` (Owner/Manager/Cashier/Accountant,
  gated by the `customers.view`/`customers.manage` permissions), independent of the `ledger`
  feature flag; it links into each customer's AR statement for whoever can also see the ledger.
- **Bank & cash reconciliation**, **expense management** (categorised, with attachments and
  recurring expenses), and **payroll entries** (accrual/payment postings, not a payroll engine).
- **Manual journals** — draft → review → post, reversal rather than deletion, recurring
  templates, and an approval permission distinct from posting.
- **Chart-of-accounts customisation** and **VAT/tax reporting** (output vs. input VAT, net
  payable position).

## Feature Gating & Platform Hardening (Phase 17)

With many businesses on one deployment, this phase is what makes it safe to run for paying
strangers rather than just isolated by construction:

- **Flag-driven gating** — the feature flags Phase 12 modelled and Phase 15 administers actually
  gate UI *and* API; a disabled feature is hidden in the nav and refused at the guard, not just
  hidden client-side.
- **Plan limits** (`plans` table, `src/lib/plan-limits.ts`) — per-plan ceilings on branches,
  members and monthly orders, enforced at the point of creation with a clear Persian error
  rather than a crash. Three tiers ship by default (`free`/`pro`/`business`); exceeding a limit
  blocks the action, it never degrades existing data.
- **Per-tenant export & restore** — see [Backups](#backups-phase-10) above.
- **Tenant-scoped rate limiting** (`src/lib/rate-limit.ts`, enforced in `src/middleware.ts`) —
  per-business, per-sync-token, and per-IP-on-login limits so one business's traffic (or a
  runaway offline-sync client) can't degrade another's.
- **Generated isolation test suite** (`integration/tenant-isolation.integration.test.ts`) — proves,
  from `pg_policy` itself, that every tenant table's RLS policy both exists *and* actually scopes
  by business — a future migration that adds a table without one fails CI, not production.
- **Multi-tenancy performance review** — `integration/query-performance.integration.test.ts`
  proves the RLS design stays index-backed at realistic scale; `DB_POOL_MAX`
  (`src/lib/pool-config.ts`) replaces a hardcoded pool size; `scripts/order-perf-benchmark.ts`
  established the first order/payment latency baseline.
- **Security review** — impersonation revocation is now actually enforced (not just recorded),
  the tenant and platform-admin realms reject each other's session tokens, server-sync moved off
  a single global token onto per-business hashed tokens, and `JWT_SECRET` now has a minimum
  length requirement in production (`src/lib/jwt-secret.ts`), not just an unset/placeholder check.

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
