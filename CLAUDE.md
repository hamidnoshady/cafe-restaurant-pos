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

## Prompt vocabulary — how the user names things

These words have a specific meaning in prompts from the user. Interpret a request
this way first; do not assume the everyday English sense, or the sense a code
comment happens to use, until you have checked this list.

- **Platform** means this whole product — the entire repo / system (POS, accounting,
  CRM, growth, both website managers, the AI assistant, tenancy, the super-admin
  console, desktop, the lot). A prompt about "the platform" is **not** a prompt about
  `src/app/platform/**` unless they also say super-admin / platform console. In
  *code* those paths, `requirePlatformAdmin`, platform credits, and a CMS "platform
  key" keep their existing technical meaning; do not rename them, and do not treat a
  platform-wide request as a super-admin-console task.
- **App** means a dashboard app from `src/lib/apps.ts` — accounting, growth, CRM,
  sales, operations, website, WP manager, connections, settings — the things in the
  workspace rail. It does **not** mean the Next.js application, the Electron desktop
  installer, or the WordPress plugin. The AI assistant is not an app (see below).
  When they name one ("the accounting app", "growth", "CRM"), stay inside that app's
  ownership boundary; don't add a peer page in another app's shell.
- **AI assistant** (also «دستیار هوشمند», "the assistant") means the platform's
  **main page**: the full-page chat home at `/dashboard` (when the workspace flag is
  on) and `/dashboard/ai`. It is the workspace home, not a rail app — `apps.ts`
  leaves `ai` unassigned on purpose. A prompt about the AI assistant is about that
  home surface (chat, tools, replies), not about MCP, coworker jobs, or autopilot
  unless those are named.
- **Website management** means **both** website systems, not one of them:
  1. **Eshobe CMS** — the `website` app at `/dashboard/website` (`src/lib/cms/*`,
     [docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md)).
  2. **WP / Woo management** — the `wp` app at `/dashboard/wp` (WordPress/WooCommerce
     manager, Phase 40; plugin in `wordpress-plugin/`).
  They are peers. Never fold one into the other, never treat WP Manager as a
  Connections tab or the CMS as a Growth section, and if a prompt says "website
  management" without naming which, consider both (or ask which) rather than
  defaulting to the CMS.

## Test and build, locally — before every commit

Run these from the repo root before considering any change done. CI (see below) is
manual-only — it does not run on push, PR, or merge — so it is not a substitute for
running the checklist yourself first:

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

## CI — `.github/workflows/test.yml`

Both workflows in `.github/workflows/` are **manual only** (`workflow_dispatch`). They do
**not** run on push, on a pull request, or after a merge to `main`. Start them from the
Actions tab when you want a run.

`test.yml` is the same checklist as above — type check, unit tests, integration tests,
production build — as four independent jobs in parallel (not one sequential job) so the
run's wall-clock time is the slowest single check, not their sum; a `required` job fans
the four back in to one status check. It is not a gate on PRs or on `main`.

What follows from that:

- **Run the local checklist above yourself, every time, in full — don't wait on CI.**
  Nothing runs unless you dispatch it; nothing else will catch a change that breaks the
  type check or a test as fast as running it yourself.
- Don't report a change as done on the strength of a partial run. `npm test` passing while
  `npm run test:db` was never started is not a green checklist; say which steps you actually ran.
- Keep `.github/workflows/test.yml` in sync with the checklist above — if a step is added, removed
  or renamed here, update the workflow (and vice versa) in the same change.
- Don't re-add `push` / `pull_request` / `workflow_run` triggers. Manual-only is the
  decision; an automatic run on CI or after merge is a regression.

`.github/workflows/build-and-push.yml` is the same: dispatch it from the Actions tab when
you want an image. It builds and pushes `docker.io/<DOCKERHUB_USERNAME>/cafe-restaurant-pos:sha-<short-sha>`
(and `:latest`) to Docker Hub for the commit you selected — it does **not** wait on `test`,
and it does **not** run after merge. Don't assume an image exists for a branch, a PR, or a
commit nobody dispatched against. This is what the self-update path (`src/lib/app-update.ts`,
`scripts/check-app-update.ts`, `/platform/updates`) and the pull-based compose files
(`docker-compose.local.yml`, `archive/deploy/docker-compose.srv1.yml`) expect.
**Production (Runflare) does not consume this image yet** — it still builds from the
`Dockerfile` itself per `docs/server-migration.md`'s Runflare recipe; repointing it at the
prebuilt tag is a separate, deliberate step, not something this workflow does on its own.

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

The origin is the **only** thing that names a tenant in a URL: the `/{slug}/dashboard` prefix was
deleted in Wave 5, so don't reintroduce a business identifier into a path. `ROOT_DOMAIN` is what
switches host tenancy on (it may itself be a subdomain — `biz1.ac.eshobe.com` under
`ROOT_DOMAIN=ac.eshobe.com`), and a subdomain is **typed in English by a super-admin**, never
derived from the Persian business name. Anything that resolves a tenant before a session exists
(the login family, WebAuthn's expected origin) must ask the host, not a field in the body.

Three rules follow for the database side:

- **A new tenant-scoped table needs an RLS policy** in the same migration that creates it.
  `integration/tenant-isolation.integration.test.ts` fails if one is missing — that failure
  is a real bug, not a test to update.
- **Don't add `withoutTenantScope()` calls casually.** Each one is a hole in the isolation
  boundary. Seven reasons are justified today (see `src/lib/db.ts`'s doc comment on
  `withoutTenantScope` for the authoritative list): resolving a login email to its memberships
  before a business is chosen; platform administration; resolving a server-sync bearer token to
  its business before any tenant is chosen (the same shape as login); resolving a public API bearer
  key to its business/location before a tenant has been selected; resolving an MCP bearer credential
  — a connector token or an OAuth access token — to its connection, and therefore its business and
  branch (the same shape again; the MCP OAuth flow itself needs no hole, because it names the tenant
  from the host first); a narrow write to the global
  `platform_users` table on behalf of an already-verified in-business membership (e.g.
  a password reset); re-checking a PIN login's `employee_sessions` row before a tenant scope
  has been entered for the request (the same shape as the impersonation-grant re-check it sits
  next to in `getSession()`); and resolving an inbound WooCommerce connection — by the delivery's
  connection id (webhook) or by the WordPress plugin's link-token hash — to the business its store
  belongs to. Anything else is a new hole — think hard before adding one.
- **Background work must scope itself.** Anything running outside a request — the ticks in
  `server.ts`, scripts — has no session to derive a tenant from, so it enumerates businesses
  bypassed and then wraps each one's work in `withTenant(businessId, …)`.

## The business day — read before writing a day-bucketed query

Since migration 0076, "which day did this happen on" is
`app_business_date(ts, tz, start_minutes)`, not `(ts AT TIME ZONE l.timezone)::date`. A branch may
start its trading day at any time (`locations.business_day_start_minutes`, NULL = the calendar day,
which is what the function returns for it), so a café working 18:00→03:00 keeps one service on one
date instead of splitting it at midnight. See the "The business day" section of
[README.md](README.md).

- **A new day-bucketed view or query uses the function.** Writing the timezone cast by hand
  reintroduces the split for every branch that configured a business day, and puts that screen out of
  step with every other one.
- **Don't derive a "today" window in a route.** `getBusinessDayStatus` (`src/lib/business-day-service.ts`)
  already answers it, including a manual close; the pure half is `src/lib/business-day.ts`.
- **A sale may be recorded after the fact.** «ثبت سفارش گذشته» (`/api/orders/backdated`,
  `src/lib/backdated-order-service.ts`) writes an *ordinary* `orders` row whose `opened_at`,
  `closed_at`, `payments.received_at`, `stock_movements.occurred_at` and `journal_entries.entry_date`
  are all the instant the sale happened — which is why reports, COGS, costing and the fiscal-period
  lock needed no special case. Don't build a second model for "a sale we typed in late"; the
  `backdated_orders` row records only what the order cannot say (who, why, and when it was actually
  entered). The day and time are the *branch's* wall clock, resolved server-side — never the
  browser's.
- **The night ends at the cash-up.** The live window starts at the branch's last
  `employee_shifts.ended_at` once nobody is clocked in (a handover doesn't count); «بستن روز کاری» is
  the override for branches that don't clock in. A start time alone can only say when a day begins.
- **A bill belongs to the shift/day it was *opened* in, not the one that settled it.** Every
  shift-scoped order read shares one predicate — `ORDER_OPENED_IN_WINDOW`
  (`src/lib/order-read-service.ts`) — so the orders screen's settled list and the «سفارش‌های شیفت»
  report can't disagree. A table opened at 23:30 and paid at 08:00 stays the *night* shift's sale: it
  keeps showing in that shift's list however late it closes, and the shift that took the last payment
  is not credited with it. Don't reach for `closed_at` to bucket a shift — that is the bug this
  replaced, and it got both halves wrong at once. Shift *cash* figures are a separate question and stay
  on `closed_by`/`closed_at` on purpose: `shiftCashSummary` answers "what is in this employee's till",
  so the drawer count reconciles against money they actually held.
- **Ending a day is display-only, by decision.** A cash-up or a manual close moves the live window,
  never a report's bucket — don't "fix" reports to honour them.

## Shamsi-only dates — read before showing a date anywhere

This is a hard rule, not a preference. **Every date a user sees must be Shamsi (Jalali).** Gregorian
is an internal implementation detail only.

- **Storage stays Gregorian/ISO.** Dates are stored as `timestamptz`/`date` — do NOT change that.
  Shamsi is a *presentation* rule; it is not a storage migration.
- **Every screen shows Shamsi.** This covers the user/dashboard section and the super-admin/platform
  console, and every module — accounting/ledger, loyalty & marketing, inventory, reports, exports
  (CSV/Excel/PDF), receipts, kitchen tickets, labels, notifications and the AI assistant. There is no
  "user section" exemption and no "superadmin section" exemption.
- **Never render a raw ISO/Gregorian date to a user.** A string like `2026-08-29`, `new Date(x)
  .toISOString().slice(0, 10)`, `.toString()`, `.toDateString()`, or a Gregorian-looking column is a
  bug. Format it through `src/lib/jalali.ts` — `formatJalali`, `formatShiftWindow`, `jalaliToIsoDate`
  — or `Intl.DateTimeFormat` with the `fa-IR` locale (which resolves to the Persian/Shamsi calendar).
- **Never use the native `<input type="date">`.** It opens a Gregorian calendar. Use
  `JalaliDatePicker` (`src/app/dashboard/jalali-date-picker.tsx`), whose `value`/`onChange` contract
  is still an ISO date string so callers keep storing ISO while the user only ever sees a Jalali
  calendar. It is theme-agnostic and importable from the platform console too.
- **The AI speaks Shamsi.** The assistant's system prompt already says dates are Shamsi
  (`src/lib/ai.ts`). Keep tool descriptions as ISO parameters (that is the storage contract), but the
  *answer* the model gives must phrase dates in Shamsi — never hand the model a raw Gregorian date to
  repeat back.
- **"Today" is the business's today.** Use `businessToday` / `getBusinessDayStatus`
  (`src/lib/business-day-service.ts`) or `todayJalali` for "today", never a bare `new Date()` UTC
  slice, so a branch working 18:00→03:00 keeps the right day.
- **When you add or touch any date display, add Shamsi coverage.** Prefer `formatJalali` over
  re-implementing conversion; keep `src/lib/jalali.test.ts` green.

## Pull requests — check in until merged, not just at open

Every PR from work in this repo gets watched through to a terminal state, not just opened
and left:

1. Right after pushing and opening the PR, subscribe to its activity (PR comments, review
   feedback, status checks) so you keep receiving updates on it.
2. When an event comes in — a failing check, a review comment — investigate and, if you're
   confident in the fix and it's in scope, push it and keep the PR's status current. If a
   fix is ambiguous or architecturally significant, ask before acting instead of guessing.
3. New pushes, check results and merge-conflict transitions aren't always delivered as
   events. Schedule a periodic check-in (roughly hourly is reasonable) on any PR still open,
   to catch state that webhooks missed — re-check status, mergeability and checks, act on
   anything actionable, and re-arm silently if nothing changed.
4. A PR isn't done at "opened", and there is no CI to be green (see above) — the local
   checklist is what stands in for it, and review may still be pending. Keep checking in
   until it's actually merged or closed. Stop immediately if asked to.

The only check that still reports here is an external security review app, which is not a
workflow in this repo and does not run the tests.

## Payment ways — read before touching how money is taken

Since migration 0091 a business's ways of taking money are **rows in `payment_methods`**, named and
ordered by the business, and one bill can be split across several of them (`payments` gets one row
per slice). The `payment_method` enum did not go away — it is now the *settlement* a way declares,
and the only thing the ledger sees. See the "Payment ways" section of [README.md](README.md).

- **Don't hard-code a payment list in a screen.** `GET /api/payment-methods` is the source, and
  `<PaymentWays>` (`src/app/dashboard/payment-ways.tsx`) is the picker; the arithmetic of a split
  lives in `src/lib/payment-draft.ts`, not in a component.
- **Don't add the tip into the `payments` rows.** They record the bill; `tendersWithTip` folds the
  tip into the posting only. The closed-order amendment and refund ceilings depend on that.
- **A split posts one entry, not one per slice** — `postExactOrderPaymentEntry` takes `tenders` and
  builds a debit line per settlement against a single revenue credit.

## Dashboard UI — read before adding a page or a panel

Every page and panel under `src/app/dashboard/**` is **built from the primitives in
`src/app/dashboard/page-chrome.tsx`** — `PageShell`, `PageHeader`, `SectionCard`/`cardClass`,
`TabBar`/`TabPanel`, `EmptyState`, `StatusBadge` — plus `<Button>` and `ui.tsx`'s
`inputClass`/`Field`/`ErrorBox`/`InfoBox` for controls. See
[docs/ui-conventions.md](docs/ui-conventions.md) for what each one replaces and why.

**The visual canon is [docs/design-system.md](docs/design-system.md)** — the exact colours,
borders/shadow weights, radius scale, control/table/chip recipes, hover/focus/active states
and motion vocabulary, backed by the reference screenshots in `docs/design/reference/`.
Read it before building or restyling any page or panel; the screenshots there are ground
truth, and its "old look" list is a set of regressions, not style choices.

Two rules carry the history:

- **Compose, don't re-derive.** The dashboard already went through a phase where every screen
  hand-rolled its own header spacing, tab pills and card border, and moving between two screens
  of the same product looked like moving between two products. A new page that spells out
  `mx-auto w-full max-w-[1600px]` or `rounded-2xl … shadow-sm` instead of using the shared
  component is how that comes back.
- **Teal is the brand accent, amber is selection, neutrals are warm stone.** Filled `<Button>`s
  stay teal (`--primary`); active tabs and pressed chips are `bg-amber-100 text-amber-950`;
  hairlines are `border-stone-200/80` and the card shadow is
  `shadow-[0_1px_2px_rgb(41_37_36/0.035)]`. A cool `gray-*`/`slate-*` class or a `shadow-sm` on
  a card is drift, not a choice. Dark mode is deliberately unsupported here — don't add `dark:`
  variants piecemeal.

Full-screen operational surfaces (POS, orders, floor plan, KDS, reservations) keep their own
compact icon-led chrome on purpose, and `src/app/platform/**` is a separate realm with its own
`ui.tsx`. Both are documented exceptions — don't extend them to a new dashboard page.

The canon is **executable and app-wide**: `src/app/dashboard/design-lint.test.ts` bans the
drift patterns in every dashboard file and requires every route to carry the `PageShell`
frame; `src/app/design-lint.test.ts` holds the same bans on the entry surfaces every
business type walks (login, welcome, setup, invite, consent, business directory) and on
`src/components` minus the shadcn layer; `src/app/loading-coverage.test.ts` requires a
skeleton boundary above every layout realm and a `*Skeleton` in every client component
that fetches on mount. Loading is skeletons for regions and busy-label words («در حال ثبت…»)
for actions — never `animate-spin`. Neither lint keeps a baseline, so any new violation
fails `npm test`.

## One party record — read before adding a customer, supplier or staff screen

Every counterparty the business owes or is owed by is **one row in `parties`** (migration
0137 renamed `customers` to `parties` and added `role`, the person type, the identity
columns and the tab documents). Customer, supplier and employee are a `role` on that row,
not three tables: a supplier who also buys coffee is one party, and the ledger's
receivable, the store's purchase order and the payroll advance all point at the same `id`.

- **One endpoint and one screen.** `/api/parties` (+ `/[id]`, `/categories`) and
  `src/app/dashboard/parties/{parties-section,party-form}.tsx` are the only party write
  path in the product; `src/lib/parties.ts` holds the contract both the form and the route
  validate against (`PARTY_SCHEMA`, `buildPartyPayload`, `parsePartyRequestBody`), and
  `src/lib/parties-service.ts` is the only place the party's own fields are read and
  written. What stays outside it is deliberately narrow: the CRM's own columns on the row
  (tags, consent, lifecycle stage, the merge pointer) and the two importers that fill a
  party from another system — they maintain fields the directory does not own, and neither
  may invent a party row of its own.
- **A per-app view is a scope, not a copy.** What an app lists, which columns it draws and
  whether it may edit at all come from `PARTY_SCOPES` in `src/lib/parties-scopes.ts`
  (CRM=customers, the store=suppliers, the team=personnel, Accounting=all three and the
  only one that edits the ledger fields, Growth/sales read-only). A new app that needs
  parties mounts `PartiesSection` with its scope. It does not grow a second table of "the
  suppliers I care about", its own add form, or its own archived flag — that is how one
  person ends up with three names.
- **Money-shaped fields are the ledger's.** `accountingCode`, `accountingCodeMode`,
  `general_info.taxPercentage`, `financial_info` and the national/economic codes need
  `ledger.view` on top of `parties.manage`; the gate reads the request body, because a form
  sends the whole record. Codes are allocated per business by role prefix (۱ customers,
  ۲ suppliers, ۳ staff) unless the mode is `Manual`.
- **A tab is a document.** The four jsonb tabs store the wire keys verbatim; a tab the
  request does not name is left exactly as stored, and `{}` means cleared. Never rebuild a
  full body from a partial one — that is how an archive toggle wipes an address.
- **`suppliers` is a branch alias, not a second supplier.** It keeps `location_id`, its own
  note and `party_id`; a purchase order still references `suppliers.id`, and a row with a
  party reads its name and phone from that party (`getInventoryOverview` resolves it with one
  COALESCE and `PATCH /api/inventory/suppliers/:id` refuses identity edits on a linked row).
- **Deleting is a decision, not a DELETE.** `removeParty` hard-deletes a party with no
  history and archives one with orders, receivables, points or a branch alias — the route
  returns which happened, and the section says so in Persian.
- **Permissions are `parties.view` / `parties.manage`.** Nothing named `customers.*`
  survives; stored overrides in `users.permissions` and `invitations.permissions` were
  rewritten by 0137. In user-facing Persian the subject is «طرف‌حساب», so the assistant,
  the knowledge articles and every label say «طرف‌حساب‌ها» for the record and keep
  «مشتری»/«تأمین‌کننده»/«کارمند» for the role a row has.

## Counting stock — read before touching barcodes or a physical count

Both item models can now be counted with a scanner, and they stay **two separate
implementations on purpose** — the same boundary Phase 21 Wave 1 drew and every phase since
has kept.

- **Barcodes are per model.** `item_barcodes` → `items` (retail, Phase 27 Wave 4, gated on the
  `barcode` capability) and `inventory_item_barcodes` → `inventory_items` (F&B). What they
  *share* is the pure code format in `src/lib/barcode.ts` — EAN-13/UPC-A check digits and the
  GS1 in-store prefix `2` for minted internal codes — so one scanner reads both without
  configuration. Don't unify the tables; do reuse `barcode.ts`.
- **A scanner is a keyboard.** Any scan input must stay enabled while its lookup is in flight
  and refocus afterwards, or fast consecutive reads are silently dropped. A repeat scan *adds*
  to the tally (in `Decimal`, not float — a kg-counted store room drifts otherwise).
- **Counts are per model too**, and the retail one is deliberately the small one:
  `item_stock` is a moving weighted average with no lots and no negative layers, so
  `item-stock-count-service.ts` needs none of `stock-count-service.ts`'s settlement machinery.
  A count **sets** the quantity to the counted figure rather than applying a delta (which is
  what keeps it inside `item_stock`'s `quantity >= 0` check), and **never moves the unit cost** —
  only the quantity was ever wrong.
- **Shortage and surplus never net.** They hit different accounts, so a count that is short on
  one item and over on another must post both, not nothing.
- **The retail shortage account is `5190`, not F&B's `5160`.** Cosmetics already spends 5160 on
  «کالای منقضی و تستر» — an *identified* loss — and unexplained shrinkage must not be folded into
  it. The surplus side shares `4910` with F&B, which means the same thing in every trade.
- **A posted count is corrected by reversal, never edited**, like a production run. A reversal
  applies the inverse delta (so sales made after the count survive it) and is refused once a
  counted surplus has been sold.

## The AI coworker — read before touching a recurring AI job

Since Phase 32 an owner can hand the assistant a *standing* instruction — «هر شب که شیفت بسته
می‌شود، ماندهٔ نان را ضایعات بزن» — as a **job** (`ai_coworker_jobs`) that fires on a business event
or a schedule and lands in an approval inbox at `/dashboard/ai` ← «همکار هوشمند». See the "AI
coworker" section of [README.md](README.md) and
[docs/phases/Phase-32-AI-Coworker.md](docs/phases/Phase-32-AI-Coworker.md).

- **A job is deterministic — never call a provider from one.** Its actions are built by a pure
  builder in `src/lib/ai-coworker-templates.ts` from params plus facts the service read. That is why
  a job costs no credits, needs no credit opt-in, and can be asserted to the Rial in an integration
  test. Adding a model call to a job path removes the only basis on which an owner could
  pre-approve it.
- **Params hold intent; the database holds numbers.** A job stores *which item and why*, never a
  quantity. `loadFacts` reads the current figure at fire time and the builder clamps to it.
- **A new template adds a builder, not a branch elsewhere.** Declare its module, scope, triggers and
  emitted actions in `COWORKER_TEMPLATES`; the API narrows by module and the form renders from
  `template.params`.
- **`approvalMode: 'auto'` never bypasses Phase 31.** `planCoworkerActions` still runs every action
  through `evaluateAutopilotProposal` against the same per-category settings. Don't add a path that
  applies an action without it, and don't let over-cap mean dropped — it means held, and the held
  action must apply unchanged when a human approves.
- **Idempotency is the UNIQUE index**, not a read-then-write. Every firing claims
  `ai_coworker_runs (job_id, dedupe_key)` first.
- **Event producers only enqueue.** `shift-service` and `business-day-service` call
  `recordCoworkerEvent` (its own tiny module, to keep the import graph acyclic), which swallows its
  own errors: a cashier clocking out must never fail because of a background job.
- **Waste is `coworkerOnly`.** `inventory.waste.log` may run unattended, but `actionTypesForCategory`
  excludes it so an *autopilot* run — the model deciding for itself — still cannot log waste. Phase
  31's reasoning is intact; a job just supplies the "why" in advance. Don't remove that flag.
- **`accounting-review.ts` is a rule engine, and must stay one.** Never route a finding through a
  model: a plausible finding about money is worse than none. It reports and never writes; a rule
  whose query fails is named in `unavailableChecks` rather than returning "found nothing", and the
  integration test asserts that list is empty.

## Apps — read before adding a feature area or touching retrieval

Phase 36 turned the assistant from a bubble in the corner into a workspace, and made
"what the app knows" a retrievable thing. Four rules carry that work; see
[docs/phases/Phase-36-App-Ecosystem.md](docs/phases/Phase-36-App-Ecosystem.md).

- **An app is not a folder of pages.** An app is a contribution to four shared registries:
  a read tool (`toolDefinitions`/`runReadTool`), an `ACTION_CATALOG` entry with a Phase 31
  executor, a domain event (`recordCoworkerEvent`), and a posting rule in the posting engine.
  Do that and chat, MCP, the coworker and autopilot pick the new app up for free. A second
  write path, a parallel tool list, or a hand-rolled ledger call is exactly what this rule
  forbids.
- **`ModuleKey` is the gating vocabulary; `AppKey` is only grouping.** `industry-profile.ts`
  says what a trade has and `moduleForApiPath` enforces it at the API. `apps.ts` says only
  what is seen next to what. If a grouping is the *only* thing hiding a route, the hiding is
  decoration and the route is open.
- **Prompt text is built from fragments, and a database row overrides the code default** —
  not merely its version. A bad edit or an unmigrated deploy must fall back to the code
  fragment, never silence the assistant.
- **No number is ever copied into a vector.** `ai_embeddings` holds slow-moving text only —
  help, policy, procedures, item and menu descriptions, project notes, names for approximate
  lookup. Orders, stock, payments and ledger rows are read through tools at the moment of
  asking, because a vector copy of a figure on a POS is stale within minutes and makes the
  model *confidently* wrong about money. `EMBEDDABLE_KINDS` in `src/lib/ai-rag.ts` is where
  that is enforced; `NEVER_EMBEDDED_KINDS` records the exclusion so it reads as a decision.

Two more, because both of these are load-bearing and easy to undo by accident:

- **pgvector is optional, and its absence is not a failure.** Migrations `0113` and `0114`
  create the extension inside a `DO … EXCEPTION WHEN OTHERS` block and create nothing
  downstream unless `pg_extension` really has the row; `isRetrievalAvailable()` and
  `isAnswerCacheAvailable()` probe once and answer *false* if the probe itself throws. The
  desktop installer runs `embedded-postgres` with no `vector` library — it loses RAG, not
  the assistant. Don't make either migration hard-fail.
- **The answer cache key is the *business day*, not the calendar date, plus a tool
  signature.** A café trading 18:00–03:00 runs one service; a key built from the calendar
  date carries the pre-midnight answer into the next service. The signature is what makes a
  backdated order (`/api/orders/backdated`) invalidate the range it landed in. And only
  read-only turns are ever cached — `isCacheableTurn()` fails closed and is checked inside
  `storeCachedAnswer()`, not just at the call site.
- **The Growth & Marketing app (`/dashboard/growth`) is the container for every
  customer-growing surface** (Phase 36b): loyalty, campaigns/gift cards and commission are
  its sections today; messaging (#372) becomes a section of it, not a new sidebar peer.
  CRM (#367) and the website manager (#378) were seated here as forward references and
  were both later pulled out into their own apps once built — CRM because the customer
  record is read by every app, not owned by the one that markets to it; the website
  manager because it is an integration with an external system of record (eshobe-cms,
  see [docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md)), not a marketing
  engine over this app's own tables. Its dashboard never keeps a number of its own —
  every balance on it is reconstructed from `journal_lines` the way the trial balance does
  (`growth-overview.ts`), and marketing moves money only through the posting rules its
  services already own (`GROWTH_BRIDGE_CODES` is exactly ۲۳۰۰/۲۴۱۰/۲۴۲۰/۵۲۱۰). The old flat
  routes (`/dashboard/{loyalty,promotions,commission}`) redirect into the app — keep them
  that way; bookmarks and saved bottom-nav slots depend on them. **It owns its sidebar**
  (`src/lib/app-shells.ts` + `app-shell-nav.ts`): inside `/dashboard/growth*` the dashboard's
  nav slot is the app's own menu (`growth/growth-nav.ts`), with nothing from accounting listed
  beside it. A new section means an entry in that list — never a new flat page, and never a
  second menu drawn inside the page.

## The Website app — read before touching `/dashboard/website` or `/api/cms/*`

This section is the **Eshobe CMS** half of website management. The other half is the
WP / Woo manager (`wp` app, `/dashboard/wp`). In prompts, "website management" means
**both** — see Prompt vocabulary above. Never fold this app into WP Manager or the
other way around.

This app (POS/accounting/CRM) and [`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms)
(the Payload 3 multi-tenant website platform) are **separate deployments**, connected
server-to-server over REST — never embedded, never sharing a database. The contract between
them, both sides' setup steps and the credential model live in
[docs/eshobe-cms-integration.md](docs/eshobe-cms-integration.md); read it before touching
either side.

- **`website` is its own app** (`src/lib/apps.ts`), a peer of «رشد و بازاریابی» in the rail,
  not a section inside it — see the note on the `website` app entry for why (it holds one
  external system's credential, the same shape as a WooCommerce or MCP connection, not a
  marketing engine over this app's own tables). Its one page is
  `/dashboard/website` (`src/app/dashboard/website/`); `/dashboard/growth/website` redirects
  into it for old bookmarks.
- **The browser never sees the CMS key.** `connectCmsWebsite`/`provisionCmsWebsite`
  (`src/lib/cms/website-service.ts`) store it encrypted (`eshobe_cms_connections`, AES-256-GCM
  via `src/lib/integrations/secrets.ts`) and every later call decrypts it server-side inside
  `src/lib/cms/client.ts`, the only HTTP client for the CMS.
- **A read from the CMS is best-effort; a write is never reported as applied unless the CMS
  answered 2xx.** A down CMS must never take the POS down — see `client.ts`'s
  `CmsApiError`/`CmsNetworkError` split.
- **The revalidation webhook (`POST /api/cms/revalidate`) is not tenant-scoped by session** —
  it verifies an HMAC signature over the raw body instead (`src/lib/cms/webhook.ts`), because
  the CMS calls it with no user in the room. It must stay outside `withTenantScope` and outside
  the `website` module gate in `API_MODULE_PREFIXES` (`src/lib/industry-profile.ts`) — gating
  it would 403 the CMS's own publish notifications.
- **Never put a platform key where a site key belongs.** A platform key can provision a site
  and issue/revoke its keys; it cannot read or write that site's content. Reversing the two —
  handing a site key provisioning power, or a platform key content access — is the CMS-side
  patch's whole security property (see the integration doc §5/§6).

## The assistant's replies — read before adding an AI tool or touching the chat

Phase 33 fixed a chat that did not behave like one and answers that were not
grounded enough to trust. Four rules carry that work; see
[docs/phases/Phase-33-Assistant-Usability.md](docs/phases/Phase-33-Assistant-Usability.md).

- **A tool returns the label, not just the code.** Every enum a tool surfaces comes back with its
  Persian label from `src/lib/ai-labels.ts`, and every money field as `{ rial, toman, text }`. A
  label the tool returns is a fact; one the model translates on the fly is a guess, and a confident
  guess about what a status means is what makes an owner stop trusting the feature. Never hand the
  model a bare `spoilage` or a bare Rial integer and expect it to cope.
- **Never make the user carry an id.** `find_items` resolves a partial Persian name to the ids the
  action catalogue needs, and the prompt forbids asking for or printing one. A new tool that takes
  an id must have a companion path that finds it from a name.
- **A disabled row is an answer.** `find_items` returns `isActive` plus a Persian `statusLabel`;
  «غیرفعال است» is a correct reply and "پیدا نشد" for a disabled item is a bug.
- **The reply is read on a 360px phone.** Assistant replies render through
  `src/components/ai/ai-markdown.tsx`: anything intrinsically wide (a table, a code block, a long
  token) gets its own scroll box or is forced to break, so the *page* never scrolls sideways. Don't
  reintroduce `whitespace-pre-wrap` for assistant content — that is what made Markdown arrive as
  literal `**` and `|---|`.

Also: **don't put a gate in front of the answer.** The pre-send cost estimate was removed because
`/api/ai/chat` already reserves credit and refuses without it; the actual charge is shown under the
reply instead. `/api/ai/estimate` still exists, but nothing in the send path may block on it.

## The MCP connector — read before touching `/api/mcp` or its OAuth server

Since Phase 34 an owner can connect their *own* Claude, ChatGPT or Codex to their business through
an MCP server at `/api/mcp`, set up from «اتصال‌ها ← دستیارهای هوش مصنوعی». See the "Connecting
Claude, ChatGPT and other assistants" section of [README.md](README.md) and
[docs/phases/Phase-34-MCP-Connector.md](docs/phases/Phase-34-MCP-Connector.md).

- **The read tools are the assistant's own, not a copy.** `mcpReadTools()` reshapes
  `toolDefinitions("dashboard")` and dispatches through `runReadTool`. Adding a read tool to `ai.ts`
  adds it to MCP for free — which is the point: a question asked in Claude and the same question
  asked in «دستیار» must not be able to disagree about last week's revenue, since only one of them is
  in the room to be corrected. Do not write a parallel catalogue.
- **The write tools are exactly the `ACTION_CATALOG` entries with an `executor` and no
  `coworkerOnly` flag** — `assertWriteToolsMatchCatalogue()` fails the unit test if that drifts. Each
  runs the same Phase 31 executor a coworker job runs, so **MCP opens no new mutation path**. Waste
  stays absent: Phase 32 let a *job* log it on the strength of a fact the owner wrote down in
  advance, and a model in a chat window has written down nothing.
- **`pos.read` and `pos.write` are independent grants, and write *trust* is a third axis.**
  `write_mode` is `'approve'` (the write waits in the owner's list and changes nothing) or `'apply'`.
  Never default a connection to `apply`, and never let a scope widen anywhere except through the
  consent screen or the owner's own PATCH.
- **The 401's `WWW-Authenticate` header is the whole discovery chain.** A client that has never seen
  the business reads it, follows it to `/.well-known/oauth-protected-resource`, finds the
  authorization server and registers itself. Removing or narrowing it breaks no test — it breaks
  "paste a URL and press connect", silently, in a client that shows no error.
- **In `/authorize`, `client_id` and `redirect_uri` are validated before anything else.** Only once
  both are known-registered does another failure become a redirect. The other order makes the
  endpoint an open redirect. For the same reason the consent hand-off emits a **relative**
  `Location`: `request.url` in a route handler is the container's origin, and rebuilding it from
  `x-forwarded-host` would let a client-supplied header choose the destination.
- **PKCE is S256 only, codes are claimed with a conditional `UPDATE`, and refresh rotates** and
  re-reads the connection's current scopes — so narrowing a connection cannot be undone by a refresh.
- **Everything is tenant-scoped from the host.** The OAuth endpoints resolve the business with
  `resolveMcpTenant` (Phase 23's "ask the host" rule) and then work inside `withTenant`; only the
  bearer lookup bypasses, under the documented `mcp-token-auth` reason. Do not add a second hole.

## Notifications — read before adding an alert or touching push

Since Phase 35 the app can reach a person who is not looking at a screen, over **Web Push**
(RFC 8030/8291/8292 — one implementation covering iOS, Android and Windows). See the
"Notifications" section of [README.md](README.md) and
[docs/phases/Phase-35-Notifications.md](docs/phases/Phase-35-Notifications.md).

- **A producer only enqueues.** `recordNotification` (`src/lib/notification-events.ts`) is one
  INSERT that swallows its own errors — the same tiny-module shape and the same contract as
  `recordCoworkerEvent`, for the same reason: a cashier closing their till must never wait on, or
  fail because of, an HTTPS round trip to a push service. Only `runNotificationTick` sends.
- **A new event key needs a producer in the same change.** `NOTIFICATION_EVENTS` is the catalogue
  the settings screen renders from, so a key nothing emits is a switch that does nothing — worse
  than an absent one. `inventory.low_stock` is the one *scanned* producer
  (`notification-scans.ts`), because stock leaves an item through six different paths and a
  crossing is a property of the level, not of any one of them.
- **A missing rule is a default, not a silence**, and no event defaults a `cashier` or `kitchen`
  member into anything. An app that buzzes every till phone gets its permission revoked in a week,
  and then none of it works.
- **Quiet hours suppress the push, never the bell row.** «بیدارم نکن» is not «به من نگو». Only a
  `critical` event overrides the window; `backup.failed` is the only one, and the exception is its
  whole justification.
- **Dedupe on the fact, never on the moment.** `notification_events` has UNIQUE
  `(business_id, dedupe_key)`; build the key from the shift/run/order id through
  `notificationDedupeKey`.
- **A notification is not an `ACTION_CATALOG` action.** It writes nothing to the books and needs no
  approval, so it never goes through Phase 31's autopilot machinery — an «ask me first» job would
  otherwise have to ask permission before telling anyone anything. AI features emit them directly
  from `fireCoworkerJob`'s outcome points, and MCP's write catalogue is unchanged.
- **Never rotate the VAPID pair.** The public half is inside every subscription a browser has ever
  minted; changing it invalidates every device on the deployment with no error to notice. The row
  in `platform_push_config` is written once (`ON CONFLICT DO NOTHING` plus a re-read), and that
  table is in `EXEMPT_TABLES`.

## Repository layout

- `src/app/api/**/route.ts` — route handlers. Every handler starts with a guard
  (`requireRole(...)`/`requirePermission(...)` from `src/lib/auth.ts`) and resolves the
  caller's active branch via `resolveActiveLocation(session)` (`src/lib/setup-state.ts`) —
  since Phase 14 a business may have several branches; this always returns the one the
  caller is currently scoped to, validated against their branch assignment.
- `src/app/dashboard/**` — authenticated UI (role-gated per page/route in the sidebar nav),
  built from `page-chrome.tsx` — see "Dashboard UI" above.
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
- **Industry modules (Phase 21, Phase 25)** — a business has an `industry`
  (`src/lib/industries.ts`), set by a super-admin when provisioning it from the platform console and
  changeable there afterwards (additively and audited — see Phase 25's doc for why that is safe).
  That choice selects its chart of accounts (`coaTemplateForIndustry`), its setup-wizard steps
  (`wizardStepsForIndustry`), and — since Phase 25 — **which modules it has at all, what they are
  called, and how it sells**, all from one place: `src/lib/industry-profile.ts`. Since Phase 27 the
  profile also carries a per-trade `capabilities` field for finer-grained switches (`barcode`,
  `batch_expiry`, `repairs`). Prefer adding to
  that profile over adding an `if (industry === …)` anywhere else. A module the trade does not have
  is refused at the API guard (`moduleForApiPath` in `withTenantScope`), not merely hidden from the
  nav — the same discipline `features.ts` follows. The retail industries sell through a multi-line
  invoice (`retail-invoice-service.ts`) that is an `orders` row settled by Phase 21's own sell
  services, so no posting rule is duplicated. There are **five** trades: `food_service` is the original F&B app;
  `jewelry`/`watch`/`accessories`/`cosmetics` build on a
  parallel `items`/`item_serials`/`item_weight_attributes`/`item_stock` model and post through the
  domain-event engine (`src/lib/posting-engine.ts` + each industry's `*-posting-rules.ts`) rather
  than hand-written ledger functions. Cosmetics adds `item_batches` on top (batch/lot number, expiry,
  sold first-expired-first-out via `src/lib/fefo.ts`); every trade shares one promotion engine
  (`src/lib/promotions.ts`) and one loyalty engine (`src/lib/loyalty-service.ts`). **F&B's
  `menu_items`/`inventory_items`/recipes are never
  migrated onto that model, by decision** — see the phase doc's "Revised" scope note before assuming
  otherwise. Industry-gated pages and routes use `src/lib/industry-guard.ts`, the industry-keyed
  counterpart of `features.ts`.
- **App availability (migration 0128)** — the *third* gating axis, and the only one that is
  temporary and announced rather than hidden. A feature flag answers "did this business buy
  it?", a module "does this trade have it at all?"; this answers **"is the app released and
  working right now?"** — `available` / `beta` / `coming_soon` / `maintenance` / `disabled`,
  per app in `src/lib/apps.ts`. Set platform-wide at `/platform/apps`, overridable for one
  tenant on its «قابلیت‌ها و اتصال» tab; both behind `features.write`. Rules live in
  `src/lib/app-availability.ts` (framework-free, unit-tested), the DB half in
  `src/lib/app-availability-service.ts` (`app_availability` = a global catalogue with no RLS,
  like `feature_flags`; `business_app_availability` = tenant data, RLS'd, like
  `business_features`). Enforcement mirrors the other two axes: `withTenantScope` refuses a
  blocked app's routes with **503 `app_unavailable`**, and the dashboard layout wraps its
  children in `AppAvailabilityGate`. The deliberate difference: a blocked app **stays in the
  nav** wearing its state badge and its pages render the explanation screen — «به‌زودی» and
  «در حال تعمیر» are facts a business should be told, not absences to guess at. An override
  replaces the platform row wholesale (never field-by-field), `beta` is usable and only
  labels, and `available_from` is stored Gregorian and always rendered Shamsi.
- **In-house production (Phase 29)** — some F&B items are *made*, not assembled: a cake is built
  from raw materials once, yields 8 slices, and each slice is sold through its own serving recipe.
  A formula (`production_formulas`) and a run (`production_runs`) sit between the two, under the
  «تولید» tab of `/dashboard/inventory` and `/api/inventory/production/*` — so they inherit the
  `inventory` flag and F&B module with **no new gating**. The load-bearing rule: **the produced good
  is an ordinary `inventory_items` row** flagged `is_produced`, which is why recipes, costing,
  sale-time deduction, stock counts, pricing and cost drift all needed no change. Don't build a
  second model for "a thing we make". A run's cost is spread over the *actual* yield, its optional
  conversion cost is capitalised through a WIP wash account (`1310`) crediting a **contra**-expense
  (`5180`, so the wage in `5200` isn't counted twice), and it is corrected by reversal, never edited.
- `src/lib/*.ts` — framework-free logic (money, dates, digits, order totals, …); these are
  what `*.test.ts` files cover. `src/lib/db.ts` and files that call `query()`/`getPool()`
  are the DB-touching exception and aren't unit-tested directly.
- `migrations/NNNN_*.sql` — forward-only, applied in filename order by `scripts/migrate.ts`.
- `scripts/*.ts` — standalone CLI tasks run with `npx tsx` (migrate, seed, backup/restore,
  role provisioning, perf benchmarks, …) rather than through a route handler; some run inside
  the running container itself (e.g. `check-app-update.ts`, invoked via `docker compose exec`
  by the on-site launcher — see the README's "On-site deployment" section).
- **Warehouse counting** — barcode assignment and label printing for F&B live under the
  «بارکد و لیبل» tab of `/dashboard/inventory` (`/api/inventory/barcodes*`), and the retail
  physical count under `/dashboard/stock` (`/api/stock/counts*`). Both inherit an existing
  module (`inventory` and `stock` respectively) with **no new gating**, the way Phase 29's
  production tab does — gate a new tab, never the hub.
- **Connections (Phase 28, Phase 34, Phase 38w)** — everything a business connects *to* lives behind one hub,
  `/dashboard/connections` (`src/lib/connection-kinds.ts`), with five kinds: the desktop
  install, a WooCommerce store (now WP Manager's, hidden from the hub), Holoo, the business's
  **website** (Phase 38w — owner-only, `integrations`), developer API keys for `/api/v1`, and
  (Phase 34) the MCP connector an owner points their own Claude/ChatGPT/Codex at. The page is
  deliberately **not** feature-gated — its tabs have three different entitlements and one
  (desktop pairing) has none — so gate a new tab, never the hub. Two rules carry the
  history: a desktop install is claimed with a **pairing code** issued by the Owner from
  their own dashboard (`/api/connections/desktop`), *not* with the `POS1-…` server-sync
  token, and the address handed to the desktop is **this request's own origin**, never
  `PLATFORM_BASE_URL` — the same "ask the host" rule Phase 23 states for login. A
  WooCommerce store connects in one of two `link_mode`s: the original `rest_api`
  (consumer keys, app calls store) or `plugin`, where the WordPress plugin in
  `wordpress-plugin/` does all the calling and authenticates with a link token plus an
  HMAC envelope over timestamp, nonce and body (`src/lib/integrations/plugin-link.ts`).
  Both modes feed one ingest path (`applyIngestEvent`) and one outbox — in plugin mode
  the app fills that queue but must never drain it. Holoo is the second provider in this
  same gateway, not a parallel subsystem: SQL Server reads are profile-driven through
  `src/lib/integrations/holoo/schema-profile.ts`, web-service writes are preferred,
  direct-SQL writes require a tested known profile, a pinned profile key and the exact
  `holoo-direct-sql` arming phrase, and companion mode is bounded by
  `holoo_connection_settings.companion_activated_at`. Never add Holoo source columns to
  core tables; ownership is enforced from `integration_mappings` by `withTenantScope`,
  and the migration wizard lives at `/dashboard/integrations/holoo`, not in first-run setup.
- `wordpress-plugin/pos-accounting-connector/` — the WordPress/WooCommerce plugin (PHP,
  no build step, not part of the Next.js app). Its signing string must stay byte-identical
  to `plugin-link.ts`'s; `plugin-link.test.ts` pins the expected value on the TS side, so
  change both or neither. **Every change to the plugin bumps its version** — the `Version:`
  header and `POS_CONNECTOR_VERSION` in `pos-accounting-connector.php`, plus the `Stable
  tag` and a Changelog entry in `readme.txt` — so WordPress sites can tell an update apart.
- `electron/` — the standalone (no-Docker) desktop installer. `main.js` bundles a real
  PostgreSQL 16 (`embedded-postgres`) and runs `server.ts`/`scripts/migrate.ts` unmodified as
  child processes — see `docs/standalone-desktop-app.md`. Separate `package.json` from the
  root app (own dependencies: `electron`, `electron-builder`, `embedded-postgres`).
- `docs/phases/*.md` — one file per phase: scope, exit criteria, open questions, and (once
  built) the decisions made and where each exit criterion is satisfied in code.
- **The website is a shop window; the source of truth is here (Phase 38w).** «سایت ویترین است؛
  منبع حقیقت اینجاست.» Product, price and stock flow **one way**, from this app to the site,
  through `website_outbox` (`src/lib/website/sync-service.ts`) — the site never writes a price or
  a quantity back, and nothing in this repo reads one from it. Every call to the site goes through
  a `WebsiteAdapter` (`src/lib/website/adapter.ts`): money is integer Rial on both sides of that
  interface (the adapter converts to the site's unit from `site_currency`), content is Markdown,
  and only `WebsiteAdapterError` crosses back. Nothing goes to the site unless the owner marked the
  product (`website_product_map.sync_enabled`, default off) and switched on price and/or stock
  push separately. The outbox coalesces by UNIQUE (business, kind, product) and reads the value
  **from the database at send time**, never from the row's payload. The assistant may *draft* a
  post or product (`website.post.draft/update`, `website.product.upsert`, autopilot category
  `website`) but **`website.post.publish` is `alwaysConfirm`** — no executor, no category, no MCP
  write tool; a public text under the business's name is a person's click. Drafts use real item
  data from the read tools and never an invented price or figure.

## Phase 37 — SMS/email marketing (messaging)

> **پیام مشتری‌رو، اعتبار پلتفرمی دارد و در دفتر می‌نشیند.** Sending runs through the
> `message_outbox` and the `runMessagingTick()` on the custom server — nothing is
> sent inline and no user request ever waits on a provider. The cost is turned
> into **one journal document per campaign** by the posting engine's
> `message.campaign_cost` rule (Debit `5600 هزینهٔ تبلیغات و بازاریابی` / Credit
> `2455 پرداختنی به پلتفرم (اعتبار پیام)`), never a hand-written ledger call, dated
> on the branch's business day (`app_business_date`). The audience comes only from
> `resolveSegment(..., { purpose })` (consent + a reachable address enforced by
> the CRM bridge) — never a second member path. Provider credentials are
> platform-owned, encrypted at rest, and never returned to a business.
>
> **مدل نمی‌فرستد.** Phase 31 stands: the model may draft a template/campaign but
> pressing send is a human action. The only planned exception is a pre-authorised
> coworker-triggered job, still bounded by the Phase 31 batch caps — and even that
> is not yet shipped (see `docs/phases/Phase-37-Messaging.md` Wave 5).
