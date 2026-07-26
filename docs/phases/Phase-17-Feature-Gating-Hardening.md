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
