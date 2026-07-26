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

## Open questions

1. Should impersonation require the business owner's consent, or is a notification after the fact enough for support to be workable?
2. What is the retention policy for a hard-deleted business — immediate, or a grace window with an export?
3. Should platform admins have differentiated roles themselves (support vs engineer vs owner), or is one level enough?
4. Should the console expose raw SQL / data repair, or only modelled operations?
