# Phase 19 — Public/Platform API & Sub-App Webhooks

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 12 (Multi-Business Tenancy), Phase 14 (Multiple Branches Per Business), Phase
15 (Super-Admin Console — feature-flag override mechanism), Phase 17 (Feature Gating & Platform
Hardening — `feature_flags`/`business_features`, the server-sync bearer-token model this phase
generalizes). **Phase 18 and 18b are complete** — the prerequisite release state needed to begin this
phase is now satisfied; see the ordering note below.
**Goal:** Businesses (or developers they hire) can build "sub apps" against their own business's
data through a first-class, scoped, bearer-token-authenticated public API, instead of the platform
having no external integration surface at all.

---

## Ordering note

Phase 18 and all five waves of Phase 18b are complete. The prior release gate has therefore
been met and implementation begins with the foundation described below. Phase 19 still shares no
code, schema, or subject matter with AI billing; its staged delivery exists to keep the new external
surface reviewable and to avoid exposing routes before the key, tenancy, feature-gate, and rate-limit
controls are proven.

## Context: what exists today

Nothing external-facing exists. The only bearer-token-authenticated, session-less mechanism in the
codebase is the server-sync token (`src/lib/server-sync.ts`, `server_sync_tokens` table, migration
`0033_server_sync_token_scoping.sql`) — machine-to-machine plumbing for the Phase 5/9 offline-sync and
cross-server rollup features, not a general-purpose public API. It's the closest existing analog and
the pattern this phase generalizes: a hashed per-business token, resolved to its business via
`withoutTenantScope("server-sync-auth", ...)` before any tenant scope exists, with all real work then
done inside `withTenant(businessId, ...)`.

Every other route in the app is reached through one of two session-cookie-based realms: the tenant
realm (`src/lib/auth.ts`, staff logging into `/dashboard`) or the platform-admin realm
(`src/lib/platform-auth.ts`, Phase 15's super-admin console). Neither is suitable for a third-party
sub-app: a tenant session assumes a logged-in staff member with a role and an active branch; a
platform-admin session assumes an operator administering every business. A public API needs a third
shape entirely — a long-lived credential scoped to one business's one branch, with explicit granted
capabilities, not a role.

## Scope

- **A third parallel auth realm**, `src/lib/api-auth.ts`, alongside the tenant and platform-admin
  realms: bearer-token API keys resolved to `{businessId, locationId, apiKeyId, scopes}`.
- **API keys are self-served by the business owner**, but only once a platform admin has enabled a
  new `api_platform` feature flag for that business — mirrors Phase 17's existing feature-gating
  model exactly: a platform-controlled on/off switch, then business-level self-service underneath it.
- **Each API key is scoped to one specific location** at creation time (a business with several
  branches issues one key per branch it wants to expose), plus an explicit set of granted scopes:
  `orders.read`, `orders.write`, `menu.read`, `menu.write`, `inventory.read`, `reports.read`,
  `webhooks.manage` — modeled on `platform-admin.ts`'s `PlatformCapability`/`CAPABILITIES` shape.
- **Owner-only management.** A leaked/misused key is a standing external credential with read+write
  reach, usable from entirely outside the app — a materially larger blast radius than anything
  currently delegable to a manager (e.g. backups, settings). A new `apiManage` permission is added to
  `permissions.ts` but deliberately granted to no non-owner preset in V1.
- **V1 REST surface at `/api/v1/*`** — thin wrappers around existing service functions, never
  reimplemented business logic:
  - `GET/POST /api/v1/orders`, `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/items`
    (read+write, via the existing `order-mutations.ts` functions)
  - `GET /api/v1/menu`, `PATCH /api/v1/menu/items/:id` (read+write)
  - `GET /api/v1/inventory` (read-only)
  - `GET /api/v1/reports/*` (read-only)
  - `GET/POST /api/v1/webhooks`, `DELETE /api/v1/webhooks/:id`, `GET /api/v1/webhooks/:id/deliveries`
- **Outbound webhooks** for a minimal order-lifecycle event set (`order.created`, `order.updated`,
  `order.paid`, `order_item.status`), HMAC-signed, delivered via a durable outbox
  (`webhook_deliveries`) and a retry tick in `server.ts`, following the same discover-then-
  `withTenant`-per-business shape `runServerSyncTick` already uses.
- **A flat per-API-key rate-limit bucket** in `middleware.ts`, shaped like the existing per-sync-token
  bucket but with prefix matching over `/api/v1/*`.
- **A hand-maintained OpenAPI spec** (`docs/api/openapi.yaml`), served as JSON at
  `GET /api/v1/openapi.json` — no codegen/swagger dependency added, matching this repo's
  "framework-free, hand-rolled" convention.
- **`/dashboard/api` page** (owner-only) — create/revoke keys (secret shown exactly once, never
  retrievable again), manage webhook endpoints, view request/delivery logs.

## Out of scope

- **OAuth app-registration/consent/refresh-token flow.** A minted OAuth access token would be
  authenticated at runtime exactly like an API key (same bearer-token-to-business resolution), so the
  fast-follow work is the app-registry/consent-flow/refresh-token machinery specifically, not a second
  verification path. Named now, not built now — same treatment Phase 18 gave a real payment gateway.
- **Inventory/menu/customer webhook topics** beyond the initial order-lifecycle set.
- **Inventory writes** via the public API — real ledger/costing side effects deserve their own
  dedicated review.
- **Per-key/per-plan API usage quotas** beyond the flat rate-limit bucket. The `plans` table
  (migration 0034) is not touched by this phase.

## Exit criteria

- A business with `api_platform` disabled gets a uniform `403 {error:"feature_disabled"}` from every
  `/api/v1/*` route (checked manually inside `withApiKeyScope`, since this surface never reaches the
  session-based `withTenantScope`/`featureForApiPath` machinery).
- An owner can create a key scoped to one location and a chosen set of scopes (secret shown once,
  only its prefix retrievable afterward) and revoke it; a revoked key is rejected on its very next
  request, no caching.
- `/api/v1/orders` and `/api/v1/orders/:id/items` work end-to-end against a real business/location,
  honoring granted scopes; a key without `orders.write` gets 403 on the POST routes.
- `/api/v1/inventory` and `/api/v1/reports/*` are read-only regardless of a key's granted scopes —
  enforced by no write scope existing for them at all, not just by omission from the UI.
- A registered webhook endpoint receives a signed delivery within one delivery-tick interval of the
  triggering event; repeated delivery failures auto-disable the endpoint.
- `/api/v1/*` is verified live (a real request against a running dev server) to be reachable
  pre-session — Phase 17 decision 9 found server-sync routes were unreachable for exactly this reason
  (a missing `PUBLIC_PATHS` entry) despite correct route code; this phase must not repeat it.
- The four new tenant-scoped tables (`api_keys`, `api_request_log`, `webhook_endpoints`,
  `webhook_deliveries`) pass the existing generated `tenant-isolation.integration.test.ts` with no new
  hand-written test cases required (confirmed by reading that test: it's fully generated from
  `pg_policy`/`pg_class` introspection over the live schema, including each policy's actual
  `USING`/`WITH CHECK` expression, not just its presence — as long as each new table gets a
  `server_sync_tokens`-shaped `tenant_isolation` policy in its creating migration, it's covered for
  free).

## Decisions

1. **A third parallel auth realm, not a bolt-on to the existing two.** `src/lib/api-auth.ts` mirrors
   `auth.ts`/`platform-auth.ts`'s structure: `authenticateApiKey(request)` extracts
   `Authorization: Bearer <key>`, hashes it (SHA-256, same as `hashSyncToken`), resolves it via
   `withoutTenantScope("api-key-auth", ...)` — a 5th documented bypass reason, added alongside the
   existing four (`login`, `platform`, `server-sync-auth`, `identity`) in `db.ts`'s doc comment,
   `tenant-context.ts`'s `BypassScope` comment, and CLAUDE.md's own enumerated list, in the same
   commit. `withApiKeyScope(handler)` wraps the whole handler execution in `runInTenantScope` using
   `AsyncLocalStorage.run()` (not `enterWith()`) — the same load-bearing distinction `withTenantScope`
   and `withPlatformScope` already rely on, since `server.ts`'s background ticks call `.run()` on a
   timer and would otherwise steal the ambient scope mid-request. Every call path — success or
   failure — must explicitly set the scope (bypass-then-business, or `NO_SCOPE` on auth failure),
   never leave the ambient scope at whatever a previous pooled connection left it at, matching
   `getSession()`'s existing unconditional-scope-set rule.
2. **Key format and storage** mirrors `server_sync_tokens` exactly: `posk_live_<random>` format, only
   `key_hash` (SHA-256) stored plus a non-secret `key_prefix` (first ~12 chars) for UI identification.
   The full secret is shown exactly once, at creation, never retrievable again.
3. **Scopes model mirrors `platform-admin.ts`'s capability shape**, not the tenant `Role`/`Permission`
   system — third-party keys need coarser, explicitly-granted scopes rather than staff roles.
   `src/lib/api-scopes.ts` holds the `ApiScope` union and `requireApiScope`, validated with the same
   "unknown scope degrades safely" approach `parseOverrides` already uses for permission overrides.
4. **Each key is scoped to one location, decided explicitly over the alternative (business-wide key +
   per-request `locationId`)** — a "read-only kiosk integration" key literally can't reach another
   branch's data. `api_keys` carries a `location_id` column; every `/api/v1/*` route resolves its
   acting location from the authenticated key, not from a request parameter.
5. **`apiManage` is owner-only in V1, decided explicitly over matching `backupManage`/
   `settingsManage`'s manager-tier precedent** — a leaked API key is a standing, external, programmatic
   credential with read+write reach, a materially larger blast radius than a backup or a setting
   change. Added to `PERMISSIONS` in `permissions.ts` but not granted to any non-owner preset; revisit
   once usage patterns are understood.
6. **API usage quotas beyond the flat rate-limit bucket are explicitly deferred, decided over tying
   them to `plans` now** — mirrors Phase 18's own deferral of real billing/pricing until a product
   decision is made. The flat per-key bucket in `middleware.ts` exists only to stop one runaway
   integration from starving shared infrastructure, not to meter or bill usage.
7. **Webhook emission piggybacks on `realtime.ts`'s existing `broadcast()` call sites as a sibling
   call, not a modification to `broadcast()` itself.** There is no single "mark order paid" service
   function to hook into — payment status transition, ledger posting, and inventory deduction all
   happen inline in `orders/[id]/pay/route.ts`'s route handler, not in a reusable `lib` function.
   `broadcast()` is already called post-commit from every order-lifecycle mutation point that matters
   (`orders/route.ts`, `orders/[id]/route.ts`, `orders/[id]/pay/route.ts`, `orders/[id]/items/route.ts`,
   `orders/[id]/items/[itemId]/route.ts`, `kitchen/items/[itemId]/route.ts`) but is itself deliberately
   fire-and-forget, in-memory, not unit-tested, and not durable — wrong properties for a retryable
   webhook outbox. `emitWebhookEvent(businessId, eventType, payload)` is added as a new call at the
   same six sites, writing into `webhook_deliveries` inside the caller's already-active tenant scope
   (no bypass needed).
8. **`signing_secret` is stored in recoverable plaintext, not hashed** — it's used to *produce* an
   outbound HMAC signature, the reverse of `key_hash`/`token_hash` which only need equality-checking.
   Direct precedent: `ai-config.ts` already stores a real third-party provider API key in plaintext in
   a business's `settings` jsonb for the same reason (needed for outbound use, not inbound
   verification).
9. **New migration `0041_platform_api.sql`** — `api_keys` (business_id, location_id, name,
   key_prefix, key_hash unique, scopes text[], status, created_by, last_used_at, expires_at,
   created_at, revoked_at), `api_request_log` (business_id, api_key_id, method, path, status_code,
   created_at — only mutating requests logged, mirroring the impersonation-audit precedent in
   `withTenantScope` which only logs mutating methods, to bound table growth), `webhook_endpoints`
   (business_id, location_id, url, event_types text[], signing_secret, status,
   consecutive_failures, last_success_at, last_failure_at), `webhook_deliveries` (business_id,
   endpoint_id, event_type, payload jsonb, status, attempt_count, next_attempt_at, delivered_at,
   response_status, error, created_at) — every table gets the `server_sync_tokens`-shaped
   `tenant_isolation` policy (`USING (app_rls_bypass() OR business_id = app_current_business())`) in
   this same migration. `api_platform` row inserted into the `feature_flags` catalogue, default off.
10. **`/api/v1` added to `middleware.ts`'s `PUBLIC_PATHS`** (prefix matching already covers the whole
    route family) plus a new `apiKeyLimits` bucket keyed on a hash of the raw `Authorization` header
    with `pathname.startsWith("/api/v1/")` matching — explicitly not a copy-paste of the existing
    `SYNC_TOKEN_RATE_LIMITED_PATHS` exact-match list, which was never built to cover a route family and
    would silently rate-limit nothing if copied verbatim.
11. **OpenAPI spec is hand-maintained YAML**, no codegen tooling added — matches this repo's existing
    "framework-free, hand-rolled" convention (no swagger/OpenAPI dependency exists in `package.json`
    today).

## Planned delivery sequence (once Phase 18 ships and this phase actually starts)

This phase is intended to ship as a sequence of separate PRs rather than one large PR, each building
on the previous one's schema/auth foundation:

1. **Wave 1 — Foundation (this PR):** migration `0041_platform_api.sql`, `api-scopes.ts`,
   `api-auth.ts`, owner-only `apiManage`, and the `/api/v1` middleware/rate-limit boundary. Nothing
   user-facing yet, but the auth/scoping foundation every later PR depends on.
2. **Core data API:** the orders/menu/inventory/reports routes.
3. **Webhooks:** `webhooks.ts`, the webhook routes, and the delivery tick.
4. **Dashboard UI:** `/dashboard/api` key/webhook management page.
5. **Docs:** OpenAPI spec + keeping this phase doc's "Progress" section current.

## Open questions

1. Which payment/pricing model (if any) eventually applies to API usage — this phase explicitly
   defers it (Decision 6), but it's an open question for whenever plan-tied quotas are revisited.
2. Whether OAuth app registration (the documented fast-follow) is ever actually built, or third-party
   sub-apps remain API-key-only long-term — not decided here, since it depends on whether independent
   developers (vs. each business's own hired developer) turn out to be a real use case.

## Progress

- **Wave 1 — public API foundation:** implemented in this branch. It adds the tenant-scoped
  schema, default-off `api_platform` feature flag, scoped API-key authentication, fail-closed
  scope parsing, owner-only credential management permission, and a per-key `/api/v1/*` rate
  limit. No public data route is exposed until Wave 2.
- **Waves 2–5:** remain staged as documented below; each depends on Wave 1 and will be separately
  verified before it is opened for review.

## Status: in progress — Wave 1 foundation awaiting verification
