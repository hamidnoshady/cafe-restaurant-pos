# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Persian-first (RTL, Jalali calendar, Toman display) cafe/restaurant POS. Next.js 15 App
Router (TypeScript) + PostgreSQL 16. Development is phased — see
[docs/phases/README.md](docs/phases/README.md) for the phase index and status, and each
phase's file for its scope, the decisions made on its open questions, and where its exit
criteria are satisfied. Don't start a phase until the previous one's exit criteria are met.
See [README.md](README.md) for setup, scripts, and the storage conventions (money in
integer Rial, dates in ISO/Gregorian, Persian digits are display-only, etc.) — those
conventions are load-bearing; don't casually deviate from them.

## Test and build, locally — before every commit

Run these from the repo root before considering any change done. They mirror the GitHub
Actions `test` job (see below) exactly, so a change that fails here will fail CI too:

```bash
npm install               # first time, or after a dependency change
docker compose up -d      # start local Postgres (or point DATABASE_URL elsewhere)
cp .env.example .env      # first time
npm run db:migrate

npx tsc --noEmit          # type check
npm test                  # vitest — unit tests for src/lib/*
npm run test:db           # vitest — integration tests in integration/, needs Postgres
npm run build             # production build (JWT_SECRET only needs to be set to *something*)
```

If you added or changed anything under `src/lib/`, add or update its `*.test.ts` alongside
it (see `src/lib/orders.test.ts` for the pattern: pure functions, integer-Rial fixtures, no
DB). If you changed the schema, add a new forward-only `migrations/NNNN_name.sql` file —
never edit an already-applied migration.

## CI (`.github/workflows/deploy.yml`)

GitHub Actions, which replaced the old CircleCI pipeline. On every push to `main` and every
PR against it:

- **`test`** — `postgres:16` service, `npm ci`, `npm run db:migrate` (twice, to prove reruns
  are a no-op), `npm run test:db`, `npx tsc --noEmit`, `npm test`.
- **`build-and-push`** — builds the production image and pushes it to GHCR.

Treat a red CI run as blocking. Re-diagnose and push a fix rather than working around it or
declaring the task done with CI failing.

## Tenancy — read before touching the database

Since Phase 12 this is a multi-business platform, and isolation between businesses is
enforced by Postgres row-level security rather than by query authors (see the "Multi-business
tenancy" section of [README.md](README.md) and
[docs/phases/Phase-12-Multi-Business-Tenancy.md](docs/phases/Phase-12-Multi-Business-Tenancy.md)).

Since Phase 23 there is a **second boundary in the browser**: each business is served from its
own origin (`{subdomain}.$ROOT_DOMAIN`), the session cookie is host-scoped, and middleware
compares the host's label against the session's `businessSubdomain` claim and fails closed
(see [docs/phases/Phase-23-Subdomain-Tenancy.md](docs/phases/Phase-23-Subdomain-Tenancy.md)).
RLS protects the rows; the origin protects the cookie jar, `localStorage`, service worker, and
CSP/CORS boundary that RLS says nothing about. Never add a `domain` attribute to the session
cookie — that one change would collapse the second boundary while everything appeared to work.

Three rules follow for the database side:

- **A new tenant-scoped table needs an RLS policy** in the same migration that creates it.
  `integration/tenant-isolation.integration.test.ts` fails if one is missing — that failure
  is a real bug, not a test to update.
- **Don't add `withoutTenantScope()` calls casually.** Each one is a hole in the isolation
  boundary. Six reasons are justified today (see `src/lib/db.ts`'s doc comment on
  `withoutTenantScope` for the authoritative list): resolving a login email to its memberships
  before a business is chosen; platform administration; resolving a server-sync bearer token to
  its business before any tenant is chosen (the same shape as login); resolving a public API bearer
  key to its business/location before a tenant has been selected; a narrow write to the global
  `platform_users` table on behalf of an already-verified in-business membership (e.g.
  a password reset); and re-checking a PIN login's `employee_sessions` row before a tenant scope
  has been entered for the request (the same shape as the impersonation-grant re-check it sits
  next to in `getSession()`). Anything else is a new hole — think hard before adding one.
- **Background work must scope itself.** Anything running outside a request — the ticks in
  `server.ts`, scripts — has no session to derive a tenant from, so it enumerates businesses
  bypassed and then wraps each one's work in `withTenant(businessId, …)`.

## Pull requests — check in until merged, not just at open

Every PR from work in this repo gets watched through to a terminal state, not just opened
and left:

1. Right after pushing and opening the PR, subscribe to its activity (PR comments, review
   feedback, CI results) so you keep receiving updates on it.
2. When an event comes in — a CI failure, a review comment — investigate and, if you're
   confident in the fix and it's in scope, push it and keep the PR's status current. If a
   fix is ambiguous or architecturally significant, ask before acting instead of guessing.
3. CI success, new pushes, and merge-conflict transitions aren't always delivered as
   events. Schedule a periodic check-in (roughly hourly is reasonable) on any PR still open,
   to catch state that webhooks missed — re-check status, mergeability, and CI, act on
   anything actionable, and re-arm silently if nothing changed.
4. A PR isn't done at "opened" or even at "CI green" if review is still pending — keep
   checking in until it's actually merged or closed. Stop immediately if asked to.

## Repository layout

- `src/app/api/**/route.ts` — route handlers. Every handler starts with a guard
  (`requireRole(...)`/`requirePermission(...)` from `src/lib/auth.ts`) and resolves the
  caller's active branch via `resolveActiveLocation(session)` (`src/lib/setup-state.ts`) —
  since Phase 14 a business may have several branches; this always returns the one the
  caller is currently scoped to, validated against their branch assignment.
- `src/app/dashboard/**` — authenticated UI (role-gated per page/route in the sidebar nav).
- `src/app/platform/**` (Phase 15) — the super-admin console, a separate auth realm from the
  tenant dashboard, and since Phase 23 served from its **own host** (`admin.$ROOT_DOMAIN`)
  rather than from a tenant's origin — middleware redirects `/platform` reached anywhere else. **Any functionality that supervises or administers clients across
  businesses — not just one business's own data — belongs here, not in a per-business
  dashboard.** Update management (which businesses are on the latest app version, the S3
  config that distributes desktop-installer updates — `/platform/updates`) is the concrete
  example so far; the same rule applies to anything shaped like it in the future. Route
  handlers guard with `requirePlatformAdmin()`/`requirePlatformCapability(...)` from
  `src/lib/platform-auth.ts`, not `requireRole`/`requirePermission` — see
  `src/lib/platform-admin.ts` for the role→capability mapping.
- `src/lib/*.ts` — framework-free logic (money, dates, digits, order totals, …); these are
  what `*.test.ts` files cover. `src/lib/db.ts` and files that call `query()`/`getPool()`
  are the DB-touching exception and aren't unit-tested directly.
- `migrations/NNNN_*.sql` — forward-only, applied in filename order by `scripts/migrate.ts`.
- `scripts/*.ts` — standalone CLI tasks run with `npx tsx` (migrate, seed, backup/restore,
  role provisioning, perf benchmarks, …) rather than through a route handler; some run inside
  the running container itself (e.g. `check-app-update.ts`, invoked via `docker compose exec`
  by the on-site launcher — see the README's "On-site deployment" section).
- `electron/` — the standalone (no-Docker) desktop installer. `main.js` bundles a real
  PostgreSQL 16 (`embedded-postgres`) and runs `server.ts`/`scripts/migrate.ts` unmodified as
  child processes — see `docs/standalone-desktop-app.md`. Separate `package.json` from the
  root app (own dependencies: `electron`, `electron-builder`, `embedded-postgres`).
- `docs/phases/*.md` — one file per phase: scope, exit criteria, open questions, and (once
  built) the decisions made and where each exit criterion is satisfied in code.
