# Phase 17 — Feature Gating & Platform Hardening

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 12–16
**Goal:** The platform is safe to run for paying strangers: entitlements are enforced, tenants can't affect each other, and isolation is continuously proven rather than assumed.

---

## Scope

- **Flag-driven gating** — the feature flags Phase 12 modelled and Phase 15 administers actually gate UI and API. A disabled feature is hidden in the nav *and* refused at the guard, not just hidden.
- **Plan limits** — per-plan ceilings (branches, members, orders per month, storage) enforced at the point of creation with a clear Persian error, not a crash.
- **Per-tenant backup, restore and export** — the Phase 10 backup system currently assumes one business per database; make it export and restore a single tenant.
- **Tenant-scoped rate limiting** — one business's traffic or a runaway offline-sync client can't degrade another's.
- **Isolation test suite** — a systematic, generated test that for *every* tenant table attempts cross-tenant read, insert, update and delete, so a future migration that adds a table without a policy fails CI rather than production.
- **Performance under multi-tenancy** — index review for the new `business_id` predicates, RLS subplan cost on the hot order/inventory paths, and connection-pool sizing now that tenant-scoped queries pin a connection.
- **Security review** — a full pass over the tenant boundary: session forgery, business switching, the RLS bypass path, impersonation, and the token-authenticated server-to-server routes.

## Out of scope

- Horizontal scaling / read replicas.
- Data residency per tenant.

## Exit criteria

- Every tenant table is covered by the generated isolation test, and adding an uncovered table fails CI.
- A business on a plan without a feature cannot reach it by any route, including by hand-crafting the request.
- A single tenant's backup restores into a clean database without carrying any other tenant's rows.
- No regression against the Phase 9 performance baseline on the order and inventory hot paths.

## Open questions

1. What are the actual plan tiers and their limits?
2. Should exceeding a limit block the action or degrade gracefully (e.g. read-only)?
3. Is per-tenant export needed as SQL, or as a business-readable format (Excel/CSV per entity)?
4. What is the retention policy for `platform_audit_log` and `audit_log` at scale?

## Decisions

1. **Enforcement is centralised in `withTenantScope`, not swept across every route file.** `feature_flags`/`business_features` (migration 0020) and Phase 15's admin write path already existed; the only gap was that nothing outside the platform console ever read them. Rather than adding a `requireFeature()` call to each of the ~9 flags' dozens of routes individually, `withTenantScope` (`src/lib/auth.ts`) itself resolves the request's pathname against a static prefix→flag mapping (`src/lib/features.ts`) and 403s before the handler ever runs, once a session exists. One change at the shared wrapper every route already goes through, rather than a hundred-file sweep — the same "one enforcement point, not an audited convention" instinct as the fiscal-period lock trigger in Phase 16.
2. **Page-level enforcement is a server-side redirect, not just an emptied-out UI.** Each gated dashboard page (`inventory`, `ledger`, `reservations`, `floor`, `waiter`, `delivery`, `reports`, `branches`, `locations`, `backup`, `ai`) calls `requireFeatureForPage(businessId, flag)` right where it already checks role, redirecting to `/dashboard` — matching the exit criterion's "cannot reach it by any route, including by hand-crafting the request" more literally than leaving the page reachable with every API call inside it 403ing.
3. **The `reservations` flag also gates floor/table management (`/dashboard/floor`, `/dashboard/waiter`, `/api/tables`, `/api/table-sessions`, `/api/floor`)**, not just the booking calendar — the flag's own catalogue description (migration 0020) already reads "رزرو میز و مدیریت سالن" (table reservation *and* floor/hall management), so this is executing existing product copy, not a new judgment call.
4. **`/api/locations` (branch-resolution: `resolveActiveLocation`, used by every session) is deliberately never gated by any flag** — it's core plumbing, not an optional feature. `/dashboard/locations` (the Phase 9 cross-server rollup admin page, a genuinely optional feature) is gated under `offline_mode` instead, matching that flag's "کار بدون اینترنت... همگام‌سازی سرور محلی" description.
5. **Plan limits, per-tenant backup, rate limiting, the fully generated isolation suite, performance work, and the security review are not started** — the first three depend on the open questions above (actual tiers, block-vs-degrade behaviour, export format); the isolation-suite and performance/security items are independent follow-on slices.

## Progress

- **Flag-driven gating — implemented.** `src/lib/features.ts` is the read side of Phase 15's write side (`platform-service.ts`'s `businessFeatures`/`setBusinessFeature`): `effectiveFeatures(businessId)` resolves every flag's per-business override against its catalogue default, `isFeatureEnabled` checks one, and `featureForApiPath`/`featureForPagePath` are pure prefix-matchers (decision 3/4) mapping a request path to the flag that gates it. `withTenantScope` (`src/lib/auth.ts`, decision 1) 403s with `{error: "feature_disabled", flag}` before the handler runs whenever a session exists and its business has the matched flag off. Each of the 11 gated dashboard pages calls `requireFeatureForPage` (decision 2) alongside its existing role check; `src/app/dashboard/layout.tsx` fetches `effectiveFeatures` once and filters `NAV_ITEMS` (extended with an optional `flag` field) before it ever reaches the sidebar, and the floating AI assistant widget only mounts when `ai_assistant` is on. Verified in `src/lib/features.test.ts` (the pure path-matchers, including that `/api/locations` and unmapped prefixes like `/api/team` stay ungated) and `integration/feature-gating.integration.test.ts` (an override disabling a default-on flag, enabling a default-off one, clearing an override falling back to the default, and one business's override never leaking to another's) against a real server. Manually verified end-to-end: disabled `inventory` for a fresh business via a direct `business_features` row (what the platform console's toggle writes) and confirmed all three surfaces at once — the sidebar no longer showed "انبار", navigating straight to `/dashboard/inventory` redirected to `/dashboard`, and a hand-crafted `GET /api/inventory` returned 403 — while an unrelated flag (`ledger`) and page stayed completely unaffected; re-enabling it restored all three immediately.
- Plan limits, per-tenant backup/restore/export, tenant-scoped rate limiting, the fully generated cross-tenant attack-simulation suite, multi-tenancy performance review, and the security review — not yet started.
