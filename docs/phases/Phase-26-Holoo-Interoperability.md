# Phase 26 — Holoo Interoperability: مهاجرت *و* حالت همراه

Tracked by GitHub issue [#125](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/125),
with one sub-issue per wave: [#243](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/243),
[#244](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/244),
[#245](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/245),
[#247](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/247),
[#248](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/248),
[#249](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/249),
[#250](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/250),
[#251](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/251),
[#252](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/252).

> **این فاز یک ویژگی افزودنی است، نه بازطراحی اپ.** اپ همان اپ می‌ماند. هلو یک
> provider تازه در همان دروازه‌ی یکپارچه‌سازیِ موجود (فاز ۲۳) است — مثل ووکامرس.
> کسب‌وکاری که هلو ندارد هیچ تفاوتی نمی‌بیند: نه یک ستون تازه در جداول اصلی، نه یک
> شاخه‌ی تازه در موتور سنددهی، نه یک گام تازه در ویزارد راه‌اندازی.

## Numbering note

This phase's issue number was claimed (as #125, with waves #243–#252) while phases 27–35 were
being built on top of it, so by the time it is implemented the migration file number it
predicted — `0072` — is long since taken (`0072_impersonation_handoffs.sql`,
`0072_stock_count_corrections.sql`). The Holoo migration therefore ships as **`0103`**, the
next free number, and every reference to "0072" elsewhere in the phase issue should be read as
"the migration that opens the `provider` CHECK and creates the two tenant-scoped Holoo tables",
not as a literal filename. This is the one deliberate deviation from the issue text; nothing
behavioural follows from it.

## Context

Holoo (هلو) is a widely-deployed Iranian accounting/ERP desktop application. Two broad classes of
prospect reach this product from it:

1. **Migration** — a business that wants to leave Holoo entirely and needs its goods, persons,
   chart of accounts, opening balances, transactions and accounting vouchers moved across, with a
   trial balance that ties out against Holoo's, and a rollback if it does not.
2. **Companion mode ("چهره‌ی هلو")** — a business that keeps Holoo as its *official* books but
   wants this app's POS, dashboard, reports and assistant on top of Holoo's own data. This is the
   larger population: it is a UI in front of a system they already trust, not a replacement.

Both share one foundation: a **version-aware Holoo adapter** plus a **mapping layer**. Migration is
that adapter run once, with a cutover; companion mode is the same adapter run continuously, with
reconciliation instead of cutover.

What the code already determines (unchanged from the phase issue):

- The app **cannot run on Holoo's SQL Server directly**. `query()` in `src/lib/db.ts` is a thin
  `pg` wrapper called from ~800 sites; `PoolClient` from `pg` sits inside internal service
  signatures; the SQL is Postgres-specific (`jsonb`, `gen_random_uuid()`, `ON CONFLICT`,
  `numeric(24,9)`, partial indexes); and — decisively — tenant separation is enforced by Postgres
  **Row-Level Security** (`migrations/0021_row_level_security.sql`), not by the application.
- The right skeleton already exists: the Phase 23 WooCommerce gateway
  (`src/lib/integrations/`, `migrations/0070_woocommerce_integration.sql`) has a connection with
  AES-256-GCM-encrypted credentials (`secrets.ts`), an outbox with backoff/dead-letter
  (`retry.ts`), `integration_mappings`, `integration_reconciliations`, `integration_audit_log`, and
  a background tick in `server.ts`. WooCommerce is the proof that an external system can be added
  without touching the app's core. Holoo follows the same path; it does **not** get a parallel
  gateway.
- Today nothing Holoo-related exists in the repo. This is the first phase for it.

Holoo has two connection surfaces:

- **SQL Server** — full read coverage with no extra module. This is how we read, always.
- **Official web service** at `http://<host>:8080/TncHoloo/api/` — login with database name + user
  + password; customers, groups/units/goods, invoice and pro-forma; entity references by
  `erpcode` (base64). Whether it exposes **accounting vouchers** or only invoices is the key
  unknown that decides how much Wave 8 leans on guarded direct SQL. It is confirmed on a real
  install by `scripts/holoo-probe.ts`; until then the adapter is written so the answer is a
  *configuration* (what a profile declares the web service covers), not a hard-coded assumption.

## Decisions

| Question | Decision |
|---|---|
| Scope | **An additive feature, not a redesign.** Holoo is a second provider on the Phase 23 gateway. A business without Holoo sees no change — not in core schema, not in the posting engine, not in the setup wizard. |
| Write channel into Holoo | **Web service first; guarded direct SQL into SQL Server allowed as fallback.** Reads are always direct SQL. |
| Reference books in companion mode | **Holoo is the official books.** The app still posts to its own ledger (so reports/BI/assistant work unchanged) and reconciles against Holoo nightly. |
| Deployment | **On-prem on the local network.** The app installs as-is and opens one outbound TCP connection to SQL Server. A separate Windows bridge agent for cloud tenants (the shape the till-side print connector takes) is a follow-up. |
| SQL Server transport security | **Secure by default.** Transport encryption is on unless `HOLOO_ENCRYPT=false`, and TLS certificate validation is on unless `HOLOO_TRUST_SERVER_CERT=true` (self-signed on-prem certs). Neither the probe nor the client silently sends SQL credentials in cleartext. |
| Migration number | `0103` (see Numbering note above), not the issue's `0072`. |

> **Risk, recorded and accepted.** Direct SQL writes bypass Holoo's own validation and Holoo's
> table structure differs between versions/editions; a wrong write corrupts a live customer's
> legal books. Mitigated by: always preferring the web service when the customer has it; refusing
> direct SQL unless the probed structure matches a **known, pinned profile**; a typed confirmation
> phrase to arm it (the `DESTRUCTIVE_CONFIRMATION_PHRASE` pattern from the platform reset panel);
> a mandatory dry-run that prints the exact statements; one MSSQL transaction per document; and a
> `holoo.write` row in `integration_audit_log` per executed statement.

## Scope — Wave 1: analysis and design (no product code)

`scripts/holoo-probe.ts` is a standalone, **provably read-only** CLI (`npx tsx`, per the `scripts/`
convention) that connects to a real Holoo SQL Server with `applicationIntent = ReadOnly`, dumps
`information_schema.tables`/`.columns`, row counts, one sample row per candidate table, and a
version/edition fingerprint, and writes a JSON profile. It loads the `mssql` driver lazily so a
checkout without Holoo never pays for it (and the dependency itself is added in Wave 2, not here).
Its SQL Server connection is **secure by default**: transport encryption on (`HOLOO_ENCRYPT=false`
to opt out) and TLS certificate validation on (`HOLOO_TRUST_SERVER_CERT=true` to trust a self-signed
on-prem cert) — credentials and probed data never travel in cleartext unless an operator explicitly
opts out.

The analytical outputs this wave must settle, and their current status:

| Question | Status |
|---|---|
| Supported Holoo versions/editions | Determined by `schema-profile.ts` (Wave 2) from the probe's `fingerprint`; the probe is the instrument that *produces* the fingerprint. |
| Table mapping (goods, persons, accounts, invoice+lines, receipt/payment, stock, journal+lines) | The probe's `CANDIDATE_TABLES` encodes the canonical Holoo names; a profile records which matched and which were missing. |
| Web-service capability matrix (does it expose accounting vouchers or only invoices?) | Confirmed against a real install via the web-service half of Wave 2's client; recorded per-profile so Wave 8 leans on `direct_sql` only as far as the profile says it must. |
| Currency unit (Rial vs Toman) | Holoo stores integer **Rial**; a connection's `currency_unit` column records it and `holoo-money.ts` (Wave 2) is the single conversion point, mirroring `woo-money.ts`. |
| Collation/encoding of Persian text | Recorded by the probe (`textCollations`); the adapter assumes SQL Server's `nvarchar` and never re-encodes. |
| Gregorian vs Jalali dates | Recorded by the probe (`dateSamples`); `mappers.ts` routes dates through the existing date library, keyed on the profile. |
| Shape of `erpcode` and whether it is stable for mapping | `erpcode` is base64 over a Holoo entity reference; the web-service client decodes it and `integration_mappings` treats the decoded id as the stable key. |

## Scope — Wave 2: adapter core and connection

`migrations/0103_holoo_integration.sql` opens `integration_connections.provider` to
`IN ('woocommerce','holoo')`, makes the WooCommerce-specific columns nullable **with a new
provider-conditional CHECK that re-imposes the old NOT NULLs only for `provider = 'woocommerce'`**,
and adds two tenant-scoped tables with RLS in the same migration:
`holoo_connection_settings` (host/port/database, encrypted SQL + web-service credentials,
`holoo_version`, `schema_profile`, `currency_unit`, `write_mode`, `direct_sql_armed_at/by`,
`companion_activated_at`) and `holoo_sync_cursors` (`connection_id, entity_type` → last key/time).

`src/lib/integrations/provider-registry.ts` dispatches on `provider` so `outbox-service.ts` stops
calling `createWooCommerceClient` unconditionally — a behaviour-preserving refactor. New
`src/lib/integrations/holoo/`: `client.ts` (`HolooClient`, `createSqlServerClient` with dynamic
`import("mssql")` and an injectable driver seam like `FetchLike`, `createWebServiceClient`),
`schema-profile.ts` and `mappers.ts` (both pure and unit-tested), and `connection-service.ts`
(CRUD over the two tables, credentials via `encryptSecret`/`decryptSecret` — the one existing
ciphertext store; plaintext never returned to the UI). Routes under `/api/integrations/…` accept
`provider: 'holoo'` and the test endpoint additionally probes version and profile match. A Holoo
card lands in `integrations-manager.tsx`. `package.json` gains `mssql`.

## Scope — Wave 3: import base data

Goods → `menu_items` (food service) or `items`/`item_stock` (retail), chosen by
`industryProfile(industry).salesModel`; customers and suppliers → `customers`; account coding →
`accounts`, **aligned with the industry's `seedChartOfAccounts` rather than blindly rewritten**;
opening inventory → `inventory_lots`/`stock_movements` through the existing services. Dry-run and
preview precede any write (the `scripts/inventory-cutover.ts` discipline). Every created row is
recorded in `integration_mappings`, which is what Wave 6's rollback and Wave 7's ownership both
depend on.

## Scope — Wave 4: transfer transactions

Sales (via `retail-invoice-service.ts` / the order+payment path), purchases (via the existing
purchase/receipt path), receipts & payments (AR/AP services from migrations `0026`/`0027`), and
stock movements (`stock_movements`/`inventory_lots` in chronological order, because FIFO is
order-sensitive). Transactions referencing an unmapped good or person are reported as
discrepancies, not silently dropped. Mappings recorded per document; dry-run + preview as Wave 3.

## Scope — Wave 5: transfer accounting

Accounting vouchers → `journal_entries`/`journal_lines` with a `source_type` marking them imported;
the general ledger is built from those lines (no separate table); opening balance → the app's
opening document; debit/credit tie-out reuses the existing instruments — the
`journal_lines_debit_xor_credit` constraint and the balance check in `posting-engine.ts` — **not
modified**. A Holoo voucher that is not balanced is reported as a discrepancy, never balanced with
a synthetic adjustment line.

## Scope — Wave 6: validation and migration wizard

Preview before import (per entity type: rows read / to create / already mapped and skipped /
problematic); discrepancy report (count and balance by entity type, Holoo vs app, including the
Wave 5 account-by-account trial balance); rollback of one import run (keyed on the
`integration_mappings` rows Waves 3–5 wrote, scoped to that run's id); and a multi-step Migration
Wizard (connection → data scope → preview → apply → discrepancy → rollback) on **its own page**
under the integrations section — never a step in the setup wizard (`src/lib/wizard-steps.ts` and
`src/app/setup/**` untouched). Dry-run/`--apply` discipline per `scripts/inventory-cutover.ts`.

## Scope — Wave 7: companion mode — read-only mirror, ownership, shadow books

Feature flag `holoo_companion` (default off) alongside `integrations`; `pull-service.ts` mirrors
goods/persons/accounts/stock with cursors from `holoo_sync_cursors` and upserts through
`integration_mappings`, wired as `runHolooSyncTick` in `server.ts` (three lines) — enumerating
businesses under the documented platform bypass and wrapping each in `withTenant`, with **no new
`withoutTenantScope` reason**. Ownership is one guard in one file: `withTenantScope` in `auth.ts`
consults `holooOwnedIds` (a batched lookup over `integration_mappings`) via a
`HOLOO_GUARDED_PREFIXES` map in the same style as `API_MODULE_PREFIXES`, rejecting with
`409 { error: "holoo_owned" }`; no CRUD route is edited and no `source_system` column is added.
The shadow-book time boundary is `companion_activated_at` on the connection (documents before it
are primary, after it are shadow) — `journal_entries` and `posting-engine.ts` stay untouched; only
a "دفتر رسمی در هلو نگهداری می‌شود" banner is added to accounting pages.

## Scope — Wave 8: writing into Holoo

`push-service.ts` sends the app's sales/receipts/purchases to Holoo from
`integration_outbox_events` with the existing backoff/dead-letter, an idempotency key per source
document, and the returned Holoo document number stored in `integration_mappings` and shown on the
invoice. `write_mode = 'web_service'` is preferred (Holoo validates, so the customer's books cannot
be corrupted); `write_mode = 'direct_sql'` is the guarded fallback, behind **all** of the risk
block's rails: pinned known profile or refuse, typed arming phrase recording `direct_sql_armed_at`
/`_by`, mandatory dry-run, one MSSQL transaction per document, and a `holoo.write` audit row per
executed statement.

## Scope — Wave 9: reconciliation and monitoring

`reconciliation-service.ts` compares the app's shadow documents (those after
`companion_activated_at`) against Holoo nightly, by account and period, writing
`integration_reconciliations` and rendering a discrepancy report (the WooCommerce reconciliation
page is the template). `/dashboard/integrations` monitors connection health, cursor lag, outbox
depth and dead letters. `README.md` documents the on-site deployment (the app installs as-is and
opens one outbound TCP connection to SQL Server on the same network).

## Out of scope

- `src/lib/posting-engine.ts` and every `*-posting-rules.ts` — untouched.
- No new column in `journal_entries`/`journal_lines`/`orders`/`order_items`/`customers`/
  `accounts`/`items`/`menu_items`/`inventory_*`.
- Existing CRUD routes — the ownership guard lives in `withTenantScope`, not per-route.
- `src/lib/wizard-steps.ts` and `src/app/setup/**` — the connection lives only in
  `/dashboard/integrations`.
- `electron/main.js` and the desktop installer — Postgres stays embedded; reaching SQL Server is
  one outbound TCP connection from the existing Node process.
- `src/lib/industry-profile.ts` / `industries.ts` — companion mode is a flag, not an industry.
- WooCommerce connection behaviour — the new provider-conditional CHECK re-imposes the old
  NOT NULLs for `provider = 'woocommerce'`, bit-for-bit.
- Running the app itself on SQL Server, or any non-Postgres backend.
- Adapters for other Iranian accounting packages (Sepidar, Hamkaran, Rahkaran) — the registry
  makes them possible later; not built here.
- The Windows bridge agent for cloud tenants — an independent artifact in its own
  folder, a follow-up on real demand.

## Where each exit criterion is satisfied

1. **A business without Holoo sees no behavioural change** — the `provider` CHECK is opened
   additively, the WooCommerce NOT NULLs are re-imposed for `woocommerce` only, the new tables are
   Holoo-specific and RLS-protected, and the whole existing suite stays green (verified per wave).
2. **Connect, test, detect version/profile; WooCommerce unaffected** — Wave 2's connection card,
   test route (connection + version + profile match), and the provider-conditional CHECK.
3. **Full migration ties out and rollbacks** — Waves 3–6: preview, apply, discrepancy report tying
   out count and balance, and per-run rollback.
4. **Companion mirror + `409 holoo_owned`** — Wave 7's `pull-service.ts` and the `withTenantScope`
   ownership guard.
5. **Accounting reports render unchanged in companion mode, with the official-books banner** — Wave
   7 leaves `posting-engine.ts` untouched and adds only the banner.
6. **A POS sale appears in Holoo's own UI with a mapped document number** — Wave 8's `push-service.ts`.
7. **Direct SQL refused on an unknown profile; every statement audited** — Wave 8's pinned-profile
   check and per-statement `holoo.write` audit rows.
8. **`integration/tenant-isolation.integration.test.ts` stays green** — both new tables take the
   `tenant_isolation` policy in `0103`.

## Verification

Per `CLAUDE.md`, from the repo root before each commit:

```bash
npm install
docker compose up -d
cp .env.example .env
npm run db:migrate           # run twice — the second must be a no-op
npx tsc --noEmit
npm test                     # includes schema-profile.test.ts and mappers.test.ts
npm run test:db              # includes tenant-isolation.integration.test.ts
npm run build
```

Each wave is one commit with a `<type>(<scope>): <summary> (Phase 26 Wave N)` message and a draft
PR tracked to merge per `CLAUDE.md`.

## Known follow-ups

- Confirm the web-service voucher coverage on a real Holoo install (the probe's web-service half).
- The Windows bridge agent for cloud tenants, on real demand.
- Electron installer auto-update — independent follow-up.
- Adapters for other Iranian accounting packages, enabled later by `provider-registry.ts`.
