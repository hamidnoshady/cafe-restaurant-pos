# Phase 23 — WooCommerce Integration (issue #118)

Two-way, secure, extensible integration between the POS/accounting system and
WooCommerce: orders, customers, products, stock, prices, payments and refunds,
with automatic financial posting, conflict handling, retry, audit log and
reconciliation — built so a Shopify/Magento adapter can slot in later.

This is issue #118's epic. Its six waves map directly to the issue's `## Waves`
list. Each wave is a commit on the PR; the schema for all of them lands in one
forward-only migration (`migrations/0070_woocommerce_integration.sql`) because
the tables interlock (an inbox event references a connection; an outbox event
references a mapping), and splitting them would mean repeatedly altering the
same tables in later migrations.

## Architecture principles (from the issue)

- **No direct database connection.** WooCommerce never touches Postgres; the
  app talks to it only through its REST API v3.
- **Integration Gateway.** All WooCommerce HTTP goes through one typed client
  (`src/lib/integrations/woocommerce-client.ts`); nothing else in the app
  reaches the store directly.
- **Inbox / Outbox.** Incoming webhooks land in `integration_webhook_events`
  (idempotent, deduped on WooCommerce's `X-WC-Webhook-Delivery-Id`); outgoing
  stock/price pushes land in `integration_outbox_events` and are drained by a
  background tick with retry/backoff/dead-lettering.
- **Event driven.** A WooCommerce webhook is an event; a local stock/price
  change is an outbox event. No synchronous cross-system call in a
  load-bearing transaction.
- **Idempotency.** Webhook delivery id + `integration_mappings` remote-id
  dedup make a replayed webhook a no-op; outbox events are upserted keyed by
  `(connection_id, entity_type, remote_id)`.
- **Tenant isolation.** Every new table is RLS-forced with the standard
  `tenant_isolation` policy, so `integration/tenant-isolation.integration.test.ts`
  proves the boundary the same way it does for every other table.
- **Audit trail.** Every connection change and every ingest/sync outcome writes
  `integration_audit_log`.

## Money & currency

WooCommerce prices are decimal strings in the store's own unit. The POS stores
money as **integer Rial** (`BIGINT`) everywhere (see README conventions), so
each connection records its `currency_unit` (`'rial' | 'toman'`) and
`src/lib/integrations/woo-money.ts` converts: toman × 10 → rial. Conversion is
pure and unit-tested; amounts never round-trip through floating point.

## Waves

### Wave 1 — connection infrastructure & authentication
- `integration_connections` (one WooCommerce store per business/branch).
- Credentials (consumer key, consumer secret, webhook secret) are stored
  encrypted at rest (AES-256-GCM, key derived from `INTEGRATIONS_ENCRYPTION_KEY`
  or `JWT_SECRET` — `src/lib/integrations/secrets.ts`).
- Typed REST client with Basic-auth credential header
  (`src/lib/integrations/woocommerce-client.ts`).
- CRUD + connection-test routes under `/api/integrations/connections/*`.
- Feature flag `integrations` (default off, platform-gated like `api_platform`).

### Wave 2 — receive orders & record them financially
- Public webhook endpoint `/api/integrations/woocommerce/webhook/[connectionId]`,
  authenticated by WooCommerce's HMAC-SHA256 signature
  (`X-WC-Webhook-Signature`, verified in constant time).
- `order.created` / `order.updated` / `order.restored` → idempotently create a
  completed `delivery` order (shared `order_number_counters` sequence) with a
  `payments` row (method `online`) and a balanced journal entry: debit
  bank-clearing, credit delivery-revenue + VAT payable
  (`src/lib/integrations/webhook-ingest-service.ts`).
- Line items whose WooCommerce product has a product→recipe mapping (the Wave 3
  `integration_mappings` row to a local `menu_items` row with a recipe) are
  deducted and posted to COGS through the shared POS sale path — one
  `sale_consumption` inventory event, `deductForOrder`, `postExactCogsEntry` —
  so online sales relieve stock exactly like POS sales. Unmapped lines record
  the sale with no COGS (their cost basis doesn't exist yet); see decision 3.

### Wave 3 — product, customer & mapping sync
- `integration_mappings` (remote id ↔ local id per entity type).
- Pull WooCommerce products → create/update local `menu_items` (price
  converted to Rial); pull customers → create/update local `customers`.
  Both remember the remote id in the mapping table.
- `POST /api/integrations/connections/[id]/sync/products` and `…/sync/customers`.

### Wave 4 — stock & price sync from the POS to WooCommerce
- Outbox events (`integration_outbox_events`) for `stock` and `price`, upserted
  from the background tick by diffing local stock/price against the last pushed
  value recorded on the mapping (no changes to the order-pay path).
- `runWooCommerceSyncTick()` (wired in `server.ts`) drains due outbox events,
  calls the store's `PUT /products/{id}` (stock_quantity) and
  `PUT /products/{id}` (regular_price), and applies exponential backoff →
  dead-letter after a fixed number of attempts.
- `POST /api/integrations/connections/[id]/sync/inventory` forces a push.

### Wave 5 — refund, reconciliation & error management
- `refund.created` webhook → idempotent on the refund id. When the refund's
  parent order and line items resolve through the mapping table, it flows
  through the shared customer-return path (`createCustomerReturn`): the
  balanced refund journal entry (debit sales returns + VAT payable, credit
  bank-clearing) plus an inventory recovery entry and restocked ingredient
  lots — reversing what the sale deducted, exactly like a POS return. A
  refund that can't be tied to local order items (unmapped at import,
  amount-only refund, unknown order) posts the money side alone.
- Reconciliation (`integration_reconciliations`): compares a period's
  WooCommerce order totals against the locally recorded `woocommerce_order`
  journal totals and stores the difference for review
  (`src/lib/integrations/reconciliation.ts` is the pure math).
- Retry/dead-letter state lives on outbox events; a failed or dead event is
  visible in the panel and resettable.

### Wave 6 — integration admin panel & monitoring
- `/dashboard/integrations` (Owner/Manager, gated by the `integrations` flag):
  connection list + create/edit, connection test, sync buttons, webhook URL
  with a copy affordance, per-connection inbox/outbox/reconciliation summary,
  and the audit log.

## Exit criteria

- [x] `npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build` green.
- [x] No change to any existing posting path — the order-pay route and ledger
  services are untouched except for additive re-use.
- [x] New tables pass the generated RLS isolation test.
- [x] Wave-by-wave commits, one PR, CI green, reviewed.

## Open questions → decisions

1. **Currency unit** — decide per connection (`rial` vs `toman`), default
   `toman` (the dominant Iranian WooCommerce convention). Owner sets it once at
   connection creation.
2. **Revenue channel for online orders** — recorded as `delivery` orders so the
   existing channel-split revenue account (4330) applies, rather than adding a
   new order type enum value.
3. **COGS for online orders** — posted only for line items whose WooCommerce
   product maps to a local menu item with a recipe, through the shared POS
   deduction path (`deductForOrder` + `postExactCogsEntry`, one
   `sale_consumption` inventory event linked to the same entry as the sale's
   revenue). An unmapped line records the sale without a COGS number — never
   fabricated. The cost basis for mapped lines is the same FIFO/weighted-
   average basis POS sales consume, so online sales relieve stock and post
   COGS exactly like a POS delivery sale.
4. **Multiple stores** — a connection is scoped to a business *and* optionally
   a branch (`location_id`), so one business can run several stores and a
   multi-branch business can map one store per branch.
5. **Secret at rest** — AES-256-GCM with a key derived from
   `INTEGRATIONS_ENCRYPTION_KEY` (64-hex) when set, else from `JWT_SECRET`.
   Rotating either key orphans existing ciphertexts; documented in the code.
