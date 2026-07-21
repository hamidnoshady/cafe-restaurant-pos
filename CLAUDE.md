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

Run these from the repo root before considering any change done. They mirror the CircleCI
jobs (see below) exactly, so a change that fails here will fail CI too:

```bash
npm install               # first time, or after a dependency change
docker compose up -d      # start local Postgres (or point DATABASE_URL elsewhere)
cp .env.example .env      # first time
npm run db:migrate

npx tsc --noEmit          # type check
npm test                  # vitest — unit tests for src/lib/*
npm run build             # production build (JWT_SECRET only needs to be set to *something*)
```

If you added or changed anything under `src/lib/`, add or update its `*.test.ts` alongside
it (see `src/lib/orders.test.ts` for the pattern: pure functions, integer-Rial fixtures, no
DB). If you changed the schema, add a new forward-only `migrations/NNNN_name.sql` file —
never edit an already-applied migration.

## CircleCI (`.circleci/config.yml`)

Two jobs run on every push, in parallel:

- **`test`** — `cimg/postgres:16.4` service, `npm ci`, `npm run db:migrate`,
  `npx tsc --noEmit`, `npm test`.
- **`build`** — `npm ci`, `npm run build` (no DB service; `JWT_SECRET` is stubbed only to
  satisfy the production env check — pages that read `cookies()` render dynamically, not
  at build time).

Treat a red CI run as blocking. Re-diagnose and push a fix rather than working around it or
declaring the task done with CI failing.

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

- `src/app/api/**/route.ts` — route handlers. Every handler starts with a role guard
  (`requireRole(...)` from `src/lib/auth.ts`) and resolves the caller's location via
  `getPrimaryLocation` (`src/lib/setup-state.ts`) — v1 is single-location per business.
- `src/app/dashboard/**` — authenticated UI (role-gated per page/route in the sidebar nav).
- `src/lib/*.ts` — framework-free logic (money, dates, digits, order totals, …); these are
  what `*.test.ts` files cover. `src/lib/db.ts` and files that call `query()`/`getPool()`
  are the DB-touching exception and aren't unit-tested directly.
- `migrations/NNNN_*.sql` — forward-only, applied in filename order by `scripts/migrate.ts`.
- `docs/phases/*.md` — one file per phase: scope, exit criteria, open questions, and (once
  built) the decisions made and where each exit criterion is satisfied in code.
