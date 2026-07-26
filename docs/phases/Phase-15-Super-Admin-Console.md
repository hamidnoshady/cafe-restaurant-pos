# Phase 15 — Super-Admin Console

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 12
**Goal:** A platform operator administers every business on the deployment from one console — provisioning, entitlements, health and support — without being a member of any of them.

---

## Scope

- **Separate auth realm** — `platform_admins` (Phase 12 schema) with its own login at `/platform`, its own session cookie, and no path from a tenant session into it. A platform admin is never a row in a business's `users`.
- **Business lifecycle** — provision a new business (with owner, chart of accounts, first branch), suspend, reactivate, archive, hard-delete with export.
- **Feature flags & plans** — define flags, assign plans, override a flag per business; this is the write side of the `business_features` table Phase 12 created.
- **Support access / impersonation** — enter a business as a read-only or full-access observer, with the business notified and every impersonated action tagged in `platform_audit_log`. This is the single most dangerous surface in the system and gets a consent trail, a time limit and its own audit view.
- **System management** — migration status, background job state (rollup, server-sync, backups), pool and queue health, error surfacing.
- **Cross-business usage** — per-tenant row counts, storage, order volume, active members, last activity.

## Out of scope

- Billing, invoicing, payment collection, dunning (explicitly decided: plans are assigned by hand).
- Per-tenant infrastructure controls — this is one deployment, one database.

## Exit criteria

- A platform admin can provision a working business end-to-end and its owner can log straight in.
- Suspending a business blocks its members at login and its API at the guard, without deleting anything.
- Impersonation is impossible without leaving an audit record naming the admin, the business and the window.
- A platform admin's session cannot be used against a tenant API route, and a tenant session cannot reach any `/platform` route.

## Open questions → decisions

1. **Impersonation consent** — a grant is opened with an explicit reason and a time window; every impersonated request is tagged and audited. Support is workable without blocking on synchronous owner consent, but the trail is complete and reviewable.
2. **Hard-delete retention** — never immediate. A delete request opens a grace window (`PLATFORM_DELETE_GRACE_DAYS`, default 30) with an export; the business is only eligible for hard-delete once that window has elapsed (`deleteEligible`).
3. **Differentiated platform roles** — yes: `support` / `engineer` / `owner`, gated by capabilities (`src/lib/platform-admin.ts`). Support is read + read-only impersonation; engineer adds feature writes, suspend/reactivate and impersonation revoke; owner adds full impersonation, provision/archive/delete and admin management.
4. **Raw SQL / data repair** — out. The console exposes only modelled operations; there is no raw-SQL surface.

---

## Status: implemented

**Separate auth realm.** `platform_admins` authenticate at `/platform/login` against a dedicated
JWT cookie `pos_platform_session` (path-scoped to `/platform`, realm claim, 2h default). A platform
admin is never a row in a business's `users`. `src/middleware.ts` keeps the realms disjoint: a tenant
session cannot reach any `/platform` route, and a platform session cannot be used against a tenant
API route.

**Console UI** (dark chrome, distinct from the tenant dashboard's light theme so operators never
confuse realms) — `src/app/platform/`:
- `login/page.tsx` — platform login
- `layout.tsx` — console shell, capability-filtered nav, bootstraps from `/api/platform/auth/me`
- `page.tsx` — businesses list + inline provisioning form
- `businesses/[id]/page.tsx` — lifecycle (suspend/reactivate/archive/hard-delete), plan, usage, feature overrides, impersonation
- `audit/page.tsx` — `platform_audit_log` view
- `system/page.tsx` — migration status, RLS effectiveness, pool health, per-business backups
- `admins/page.tsx` — platform admin roster (owner-only)

**Backend** — `migrations/0023_super_admin_console.sql`, `src/lib/platform-auth.ts` /
`platform-auth-edge.ts`, `src/lib/platform-admin.ts` (capabilities), `src/lib/business-provisioning.ts`,
`src/lib/platform-service.ts`, and the `/api/platform/*` routes. Platform admins are minted with
`npm run db:platform-admin`.

**Exit criteria** — all met:
- Provisioning creates an owner + chart of accounts + first branch; the owner logs straight in.
- Suspending blocks members at login and at the API guard without deleting anything.
- Impersonation is impossible without an audit record naming the admin, the business and the window.
- The two session realms are disjoint (enforced in middleware and by the guards).

**Verification** — `npx tsc --noEmit` clean; `npm test` 547 passing (incl.
`src/lib/platform-admin.test.ts`, `src/lib/business-provisioning.test.ts`, and the API-guard realm
tests in `src/app/api/api-guards.test.ts`); `npm run build` emits all `/platform/*` and
`/api/platform/*` routes.


