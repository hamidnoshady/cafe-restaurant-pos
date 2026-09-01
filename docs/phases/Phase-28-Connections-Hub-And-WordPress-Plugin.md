# Phase 28 — Connections Hub, Desktop Pairing Repair & WordPress Plugin

One subject: **everything this product connects to**, and the fact that until now only
one of those things had a place to be set up from.

The phase starts from a reported, reproducible failure and ends with a general answer.

## The reported failure

> Install the desktop version, click "use cloud for setup", go to the cloud, set the
> domain, click generate the token — it says the token is wrong. In the cloud the
> domain should be the domain you're logged in at, not some other wrong domain; just
> copy the domain, generate a token, and log in.

Both halves of that were true, and neither was a bug in the code that ran — they were
consequences of where things had been put.

**The credential.** The desktop first-run screen asks for a *pairing code*: twelve
characters, `XXXX-XXXX-XXXX`, issued for one business, redeemable once
(`install_pairing_codes`, migration 0048). The only screen that issued one was the
super-admin console (`/platform/businesses/[id]`), which a business owner cannot reach.
What an owner *could* find in their own dashboard was Settings →
«همگام‌سازی با سرور راه دور» → «ساخت توکن», which mints a `POS1-…` **server-sync token**
— a different credential, for the already-paired server-to-server channel. Pasted into
the desktop's «کد اتصال» box it produced `code_not_found`, rendered as
«کد اتصال معتبر نیست». The owner did the only thing the product offered and was told
their token was wrong.

**The address.** `pair-form.tsx` pre-filled `https://pos.eshobe.com`. Since Phase 23
every business is served from its own origin (`{subdomain}.$ROOT_DOMAIN`), so there is
no address that is right for everyone, and a pre-filled wrong one reads as an
instruction. Worse, redemption lived under `/api/platform/pairing/redeem`, and
middleware moves *everything* under `/api/platform` to the console's own host — so an
owner who did the natural thing and copied their own address would have been pairing
through a cross-host redirect.

## What this phase does

### Wave 1 — desktop pairing, repaired

- **`/api/connections/desktop`** (Owner-only, tenant-scoped) issues, lists and revokes
  pairing codes for the caller's *own* business, and returns the origin the request
  arrived on so the panel can show the address to copy. `issuePairingCode` was widened
  to accept a nullable `issued_by` (the column already allowed it) so an owner can
  issue their own; RLS's `WITH CHECK` confines the insert without a bypass.
- **`/api/pairing/redeem`** — the host-neutral twin of the platform URL, so redemption
  answers on a business origin. The original path is unchanged and both now share
  `src/lib/pairing-redeem.ts`; `/api/setup/pair` tries the new path and falls back to
  the old one, so a new desktop build still pairs against an older cloud server.
- **`/api/setup/pair/test`** — a connection test for the address *before* the one-time
  code is spent, probing the public `/api/setup/state`. A wrong address and a wrong
  code used to be the same symptom, and a code consumed against the wrong server is
  gone.
- **`src/lib/connection-code.ts`** (pure, unit-tested) — `classifyConnectionCode` names
  a pasted `POS1-…` or `posk_live_…` as the wrong credential *at the input*, and
  `normalizeServerAddress` accepts the address however it was copied: bare hostname,
  full dashboard URL with a path, Persian digits, mixed case.
- The desktop form no longer pre-fills an address, and its copy points at the panel
  that now issues the code.

### Wave 2 — the Connections hub

`/dashboard/connections` replaces the single-purpose `/dashboard/integrations` page
(kept as a redirect). Three tabs, from `src/lib/connection-kinds.ts`:

| Tab | What it connects | Guard |
|---|---|---|
| برنامه دسکتاپ | a desktop install to this cloud account | Owner; no feature flag |
| فروشگاه ووکامرس | an online store, both directions | Owner/Manager; `integrations` |
| کلیدهای API | apps built on this business's accounting data | Owner; `api_platform` |

The page itself is **not** flag-gated, and that is the point: its three tabs have three
different entitlements and one has none, so gating the page would hide the free
connection behind the paid ones. Each tab locks itself, rendering an inert preview via
the existing `FeatureLock`.

### Wave 3 — developer API tokens

Phase 19 built the whole public-API realm — key format, SHA-256 storage, scope guard on
every `/api/v1/*` route, per-key rate-limit bucket — and never built a way to obtain a
key, so the API was complete and unreachable. `src/lib/api-keys-service.ts` plus
`/api/connections/api-keys` close that: issue with chosen scopes and optional expiry
(secret shown once), list, revoke (effective on the key's very next request, since
`api-auth.ts` caches nothing). `API_KEY_PREFIX`/`apiKeyDisplayPrefix` moved to
`src/lib/api-key-format.ts` so client code can use the format without following
`api-auth.ts`'s `node:crypto` and pg imports.

### Wave 4 — the WordPress plugin link (app side)

Migration `0076_wordpress_plugin_link.sql` gives `integration_connections` a
`link_mode` (`rest_api` | `plugin`), a link token (hashed for lookup, encrypted for
HMAC verification), and plugin telemetry; consumer keys become optional in plugin mode
and mandatory in REST mode, both enforced by CHECK constraints.

`src/lib/integrations/plugin-link.ts` (pure, unit-tested) defines the envelope every
plugin request carries beyond its bearer token: a timestamp (five-minute window), a
nonce (`integration_plugin_nonces`, primary-key dedup), and an HMAC-SHA256 over
`v1:{timestamp}:{nonce}:{sha256hex(body)}`. Five endpoints under
`/api/integrations/wordpress/` — `ping`, `handshake`, `events`, `jobs`, `jobs/ack` —
all wrapped by `plugin-route.ts`, which reads the body once as text so the signature is
verified against the literal bytes that were signed.

The ingest path is **shared**: `applyIngestEvent` in `webhook-ingest-service.ts` now
serves both the webhook door and the plugin door, so a store connected either way
produces byte-identical orders, payments and journal entries.

### Wave 5 — the WordPress plugin

`wordpress-plugin/pos-accounting-connector/` — a real WordPress plugin.

- **WP → POS**: WooCommerce hooks enqueue orders, refunds, products and customers into
  a local table; nothing is sent from inside a hook, because that would put another
  host's latency into the checkout request. Each row carries one delivery id, reused
  across retries, which is the key the app dedups on.
- **POS → WP**: the cron run leases jobs from the app and applies them — stock levels,
  prices, and requests for a full catalogue or customer export — then acks each one.
- **Management**: address + token, «آزمایش اتصال», «همگام‌سازی همین حالا», retry for
  failed events, queue counts, next scheduled run, and a sync log.

Direction of travel is the reason this mode exists: the plugin does all the calling, so
a store behind a firewall, on a host that blocks incoming webhooks, or with no stable
public address works with no extra configuration — and the only credential this
database holds for it is a token scoped to this integration alone, not the store's
master REST keys.

## Decisions

1. **Self-service pairing, not a better error message.** The mix-up was possible
   because the only generator an owner could reach minted the wrong credential. Adding
   the right generator to the right screen is what removes the trap; naming the wrong
   credential at the input (`classifyConnectionCode`) is the belt, not the braces.
2. **The address comes from the request's own host, never from `PLATFORM_BASE_URL`.**
   Phase 23's rule — anything resolving a tenant before a session exists must ask the
   host — read in reverse: the address that reaches this business is the one the owner
   is signed in at. A configured constant would hand a multi-tenant deployment's apex
   to a desktop that needs `biz1.example.com`.
3. **Two redeem URLs, not a moved one.** Every desktop build in the field points at
   `/api/platform/pairing/redeem`. The new path is additive and the client falls back,
   so old desktops keep working against new servers and new desktops against old ones.
4. **The hub page is ungated; its tabs are gated.** See Wave 2.
5. **Both WooCommerce link modes stay first-class.** The plugin mode is better for
   almost everyone, but a store that cannot install plugins still needs the REST path,
   so `link_mode` is a real column rather than a migration.
6. **The plugin drains the outbox; the app does not.** In plugin mode
   `runWooCommerceSyncTick` fills the queue (local reads only) but never drains it —
   there are no REST credentials to drain it with, and trying would dead-letter every
   job the plugin was about to take. One queue, one set of retry state, two possible
   drainers.
7. **Timestamp + nonce + body HMAC, not a bare bearer token.** `/api/v1` is bearer-only
   and that is proportionate there. This channel has WordPress on one end and a
   double-entry ledger on the other, so a captured request must expire, must not work
   twice, and must not be alterable in flight.
8. **`0`/`1`/`O`/`I` in a pairing code are reported as invalid characters, not folded.**
   `normalizePairingCode` folds `0→O` and `1→I` before hashing, but the alphabet
   excludes all four, so that fold maps one never-issued character onto another — a
   code containing any of them can only ever hash to nothing. Saying so is more useful
   than letting it return as "code not found". `sync-token.ts` made the same call.

## Exit criteria

- [x] An Owner signed into their own cloud account can, without support, read the
      address to type into the desktop app and generate a code that redeems against it.
- [x] Pasting a `POS1-…` sync token into the desktop's code box is refused at the input
      with a message naming what it actually is and where the right credential lives.
- [x] The address is accepted as a bare hostname, a full dashboard URL, or with Persian
      digits, and can be tested before the one-time code is spent.
- [x] Redemption works against a business origin without a cross-host redirect, and a
      new desktop build still pairs with a cloud server that predates the new path.
- [x] `/dashboard/connections` carries all three connection kinds, role-gated, each tab
      locking itself on its own entitlement.
- [x] An Owner can issue, scope, expire and revoke a public API key from the dashboard.
- [x] A WooCommerce store can be connected by pasting one token into a WordPress plugin,
      tested from either side, and synced two ways.
- [x] The new tenant-scoped table (`integration_plugin_nonces`) passes the generated RLS
      isolation test with no hand-written case.
- [x] `npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build` green.

## Current ownership correction (Phase 40)

The original Wave 2 table above records the behavior shipped in Phase 28. The
product boundary is now stricter: WordPress/WooCommerce is not part of the
generic technical Connections app and is not an Accounting section.

- `/dashboard/connections` now renders desktop pairing, Holoo, API keys and MCP.
- `/dashboard/wp` owns the WordPress/WooCommerce manager, including its
  connection and selected store-management workflows.
- `/dashboard/connections?tab=woocommerce` and `/dashboard/integrations` remain
  compatibility URLs and redirect to `/dashboard/wp/connections`.
- The WooCommerce connection key remains recognisable to old internal callers,
  but `visibleConnectionKinds` filters it out of the technical hub.

The underlying integration gateway, plugin channel, webhooks and sync services
remain shared infrastructure. That does not change system ownership: WP Manager
owns the store-management surface and mapped store mirror, while other apps read
only the data they need for their own workflows. See
[Phase 40 — app ownership boundaries](Phase-40-App-Ownership-And-WP-Manager.md).
