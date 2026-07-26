# Phase 12 — Multi-Business Tenancy Core

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–11
**Goal:** One deployment serves many businesses, isolated from each other by the database itself; one person can belong to several businesses with a different role in each; a super-user realm exists to administer the platform.

---

## Scope

- **Global identity** — `platform_users` holds the login identity (email + password). A person logs in once and picks which business to work in.
- **Membership** — the existing `users` table becomes the *membership* record: one row per (person × business), carrying that business's role, PIN, permission overrides and default location. Every one of the 23 existing foreign keys to `users` keeps working untouched.
- **Row-Level Security** — every tenant-scoped table gets an RLS policy keyed on the `app.business_id` session setting, with `FORCE ROW LEVEL SECURITY` so even the owning role is subject to it. Isolation stops being a property of 99 correctly-written route handlers and becomes a property of the database.
- **Tenant context** — an `AsyncLocalStorage` context, established by the existing role guard, carries the active business into `query()` so route handlers don't each have to thread it through.
- **Permissions** — system roles (now including `accountant`) as presets, plus per-member grant/revoke overrides.
- **Per-user location scoping** — `user_locations` lets a member be assigned to several branches of their business; `users.location_id` stays as the default/primary branch.
- **Business lifecycle primitives** — `businesses` gains `slug`, `status` and `plan`; `feature_flags` + `business_features` provide the entitlement layer that Phase 15's console and Phase 17's gating will drive.
- **Super-user realm** — `platform_admins` is a *separate* table, deliberately not a row in any business's `users`, plus the guard and audit trail it needs.

## Out of scope

- The super-admin console UI, impersonation, business provisioning flows — **Phase 15**.
- Rewriting the 61 call sites of `getPrimaryLocation` into a real location switcher — **Phase 14**. This phase keeps that helper working (it resolves the caller's default branch) so the diff stays reviewable.
- Team invitations, member management UI — **Phase 13**.
- The accounting suite — **Phase 16**.
- Flag-driven UI gating and plan-limit enforcement — **Phase 17**.

## Exit criteria

- Two businesses can coexist in one database, and a session scoped to business A cannot read or write *any* row belonging to business B — proven by an integration test that attempts it across every tenant table shape (direct `business_id`, `location_id`-scoped, and child rows reachable only through a parent).
- One email can be a member of two businesses with different roles, log in once, and switch between them.
- A request with no tenant context reads zero tenant rows (fail-closed), rather than reading everything.
- Existing single-business behaviour is unchanged: the full Phase 0–11 test suite still passes.
- `npx tsc --noEmit`, `npm test`, `npm run test:db` and `npm run build` are all green.

---

## Questions answered before this phase

1. **Isolation strategy** — **shared database + Postgres RLS.** One migration run, one connection pool, one deployment, and the isolation boundary is enforced by the database rather than by every `WHERE` clause. Schema-per-business was rejected because migrations would have to run N times and this codebase already has 21 of them; database-per-business was rejected because the super-admin console and cross-business platform reporting would become a separate aggregation problem.
2. **Accounting depth** — **full accounting suite** (statements, fiscal periods, AR/AP with aging, bank reconciliation, expenses, payroll entries). Built in Phase 16; this phase only makes the ledger tenant-safe.
3. **Super user** — **full control plus feature flags and plan entitlements, no billing.** Plans are assigned by hand; no payment gateway, no dunning. Schema lands here, console lands in Phase 15.
4. **Locations** — all four readings apply: several branches per business, each branch optionally running its own local server, per-user location scoping, and **an on-premise install always serving exactly one business**. That last one matters here: the local-server story from Phases 5/9/11 stays single-tenant, so tenancy is a property of the *central* deployment. A local install simply has one row in `businesses` and the RLS context is constant.
5. **Cross-business identity** — **yes.** A group owner or an external accountant serves several businesses from one login.
6. **Roles** — **system-role presets plus per-member overrides**, not a full role-builder. Adds an `accountant` role for Phase 16.
7. **Existing data** — **greenfield.** No production rows to preserve, so the migrations restructure directly instead of carrying compatibility shims.
8. **Delivery** — this phase ships and is reviewed before Phase 13 starts.

---

## Design decisions

### Why `users` survives as the membership table

The obvious move — replace `users` with `platform_users` + a `business_members` join table — would have rewritten 23 foreign keys across 58 tables, every one of which records "which staff member did this" (`opened_by`, `received_by`, `created_by`, …). Those references are to *a person acting within a business*, which is exactly what a membership row is.

So `users` keeps its identity and its primary key, and gains `platform_user_id` pointing at the global login identity:

```
platform_users (id, email UNIQUE, password_hash, full_name)
      │
      └──< users (id, platform_user_id, business_id, role, pin_hash, permissions, location_id)
                   │
                   └──< user_locations (user_id, location_id)
```

One person with two businesses has one `platform_users` row and two `users` rows. `users.email` loses its **global** UNIQUE and becomes unique *per business*; the globally-unique email now lives on `platform_users` where it belongs. PIN uniqueness likewise becomes per business rather than effectively global.

Staff who never log in with a password (cashier, waiter, kitchen — PIN only) simply have `platform_user_id IS NULL`. They are members of exactly one business, which matches how a PIN login works anyway.

### RLS: the tenant GUC and the two escape hatches

Every policy resolves the current tenant through one `STABLE` helper:

```sql
CREATE FUNCTION app_current_business() RETURNS uuid
  AS $$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$
  LANGUAGE sql STABLE;
```

`current_setting(..., true)` returns NULL when unset, so **an unscoped connection matches no rows** — the failure mode is an empty result, never a leak. Tables are `ENABLE`d *and* `FORCE`d, because the app connects as the table owner and owners bypass RLS otherwise.

Three table shapes need three policy shapes:

| Shape | Example | Policy |
|---|---|---|
| Direct `business_id` | `accounts`, `settings`, `customers` | `business_id = app_current_business()` |
| `location_id` only | `orders`, `menu_items`, `stock_movements` | `location_id IN (SELECT id FROM locations WHERE business_id = app_current_business())` |
| Child of a parent only | `journal_lines`, `purchase_items`, `order_item_modifiers` | `EXISTS (SELECT 1 FROM <parent> p WHERE p.id = <fk> AND <parent policy>)` |

The location lookup is wrapped in its own `STABLE` function so Postgres hashes it into a subplan instead of re-running it per row.

Two operations legitimately cross tenants, and both go through `withoutTenantScope()`, which sets `app.rls_bypass = 'on'` for the duration of one connection checkout:

- **Login** — resolving an email to its memberships necessarily happens before a business is chosen.
- **Platform administration** — the super-user realm and the migration runner.

Every policy therefore reads `app_rls_bypass() OR <tenant predicate>`. The bypass GUC is only ever set by that one helper, and setting it is the thing to grep for in review.

### Tenant context without touching 99 route handlers

`query()` takes its tenant from an `AsyncLocalStorage` store rather than an argument. The store is established by `requireRole()` — which 93 of the handlers already call as their first statement — using `enterWith()`, so the context applies to the rest of the request without wrapping anything:

```ts
const { session, error } = await requireRole("owner", "manager");
if (error) return error;
// tenant context is live from here on; query() is scoped to session.businessId
```

`query()` then pins one connection per tenant-scoped call, issues `set_config('app.business_id', $1, true)` inside a transaction, and runs the statement. `withTenant(businessId, fn)` pins a single connection across a whole block for callers that issue many statements, and every existing `getPool().connect()` transaction path keeps working because `withTenant` is what those paths now use.

Routes that deliberately run without a session (`login`, `pin-login`, `signup`, `rollup/ingest`, `server-sync/*`) get zero rows from a tenant-scoped query, which is why each of them either establishes its own context after authenticating or uses the documented bypass.

### Permissions

`src/lib/permissions.ts` holds a flat catalogue of permission keys (`ledger.post`, `menu.edit`, `reports.view`, …) and a preset map from each system role to its keys. A membership may carry `permissions: { granted: [...], revoked: [...] }`; the effective set is `preset ∪ granted \ revoked`. `requireRole(...)` is unchanged and still used everywhere; `requirePermission(...)` is the finer-grained guard that Phase 13's UI and Phase 16's accounting routes will lean on. Owner is absolute — it holds every permission and cannot be revoked out of one, so a business can never lock itself out.

---

## Where each exit criterion is satisfied

**Two businesses can't reach each other** — `integration/tenant-isolation.integration.test.ts`,
17 assertions run over a real database as a purpose-created unprivileged role. It covers all
three table shapes: direct `business_id` (`businesses`, `menu_categories` via location),
`location_id`-scoped (`orders`), and child rows reachable only through a parent
(`journal_lines`, which carries no tenant column at all). Reads return nothing, `INSERT` and
cross-tenant `UPDATE` are rejected by `WITH CHECK`, and `UPDATE`/`DELETE` against another
tenant's rows affect zero rows while leaving the target intact. The app role also cannot
`DISABLE ROW LEVEL SECURITY` or drop a policy, because it owns no tables.

The first test in that file asserts the connection is *not* privileged. Without it every
other assertion would pass vacuously, since `docker-compose.yml` and the CI service both
make `pos` a superuser and superusers ignore RLS entirely. That is also why
`npm run db:app-role` and `assertRlsEffective()` exist.

**One email, two businesses, one login** — `platform_users` + `users.platform_user_id`
(`migrations/0020_platform_tenancy.sql`), resolved by `src/lib/memberships.ts` and exposed
through `src/app/api/auth/login/route.ts` (returns a business picker when there is more than
one), `/api/auth/businesses` and `/api/auth/switch-business`. Asserted end-to-end in the
isolation test's "cross-business identity" block, including that each business sees only its
own membership row and cannot enumerate platform identities that aren't its members.

**Fail-closed with no context** — `app_current_business()` maps an unset GUC to NULL, which
makes every policy predicate false; `scopeSettings()` in `src/lib/tenant-context.ts` maps
"no scope" to an empty string rather than anything wildcard-like. Asserted both as a unit
(`tenant-context.test.ts`) and against the database ("reads nothing at all with no tenant
context").

**Phase 0–11 behaviour unchanged** — the full pre-existing suite passes untouched. The
tenant scoping hooks `pool.connect()` rather than `query()`, so the ~30 places that check out
a client to run a transaction were covered without being modified, and the ~93 handlers
calling `requireRole` acquired their tenant context without a single edit.

**Green** — `npx tsc --noEmit`, `npm test` (34 files, 466 tests), `npm run test:db` (7 files,
35 tests), `npm run build`.

### Schema and plumbing

- `migrations/0020_platform_tenancy.sql` — identity, membership, branch assignment, business lifecycle, feature flags, the super-user realm.
- `migrations/0021_row_level_security.sql` — policies on all 59 tenant tables, plus `security_invoker` on the reporting views.
- `src/lib/tenant-context.ts` / `src/lib/db.ts` — the context and its application to every connection.
- `src/lib/permissions.ts` — role presets and per-member overrides.
- `src/lib/business-provisioning.ts` — the one path by which a business comes into existence.
- `scripts/create-app-role.ts` — the unprivileged role the app must connect as.

### Known follow-ups

- `getPrimaryLocation` still resolves the caller's *first* branch; the real branch switcher is Phase 14's job, and until then a multi-branch business behaves as it does today.
- `requirePermission` exists and is tested but is not yet applied to route handlers — Phase 13 rolls it out where `requireRole` is too blunt, so this phase changes no route's access.
- Feature flags are modelled and seeded but nothing reads them yet (Phase 15 administers, Phase 17 enforces).
