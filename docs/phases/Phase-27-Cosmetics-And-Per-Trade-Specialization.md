# Phase 27 — Cosmetics & toiletries, and a specialized identity for every trade

## Status: designed — all thirteen waves specified, implementation not started

## Numbering note

26 is already claimed by the Holoo-interoperability work (issues
[#125](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/125), #126–#130, and the newer
re-cut #243–#252), designed but not started. So this is **Phase 27**, by exactly the reasoning
[Phase 25](Phase-25-Industry-Separation.md) recorded for 24: it does not depend on Phase 26 and can
ship before it.

## Context: what exists today

[Phase 21](Phase-21-Multi-Industry-Accounting-Platform.md) built the multi-industry backend — the
`businesses.industry` discriminator, a chart of accounts per trade, the domain-event posting engine,
the `items`/`item_serials`/`item_weight_attributes`/`item_stock` model. [Phase 25](Phase-25-Industry-Separation.md)
turned the business type into a real product boundary: `src/lib/industry-profile.ts` decides which
modules a trade has, what they are called and how it sells, enforced at the API guard.

Two gaps remain, and this phase closes both.

### 1. There is no cosmetics & toiletries trade

`src/lib/industries.ts:12` knows four industries, and `migrations/0048_business_industry.sql` pins
that list in a `CHECK` constraint on `businesses.industry`. Adding a fifth is a schema change plus a
walk through the seven or eight files Phase 21 and Phase 25 established — mechanical, but nothing in
the product does it today, and a cosmetics shop provisioned as `accessories` gets a chart of
accounts that names بدلیجات and a catalogue with no concept of the one thing that governs its
stock: **expiry**.

### 2. Behind the boundary, the four trades are nearly the same app

Phase 25 drew the right line, but the behaviour behind it is thin. `grep` bears this out:

- **No expiry or shelf life anywhere.** `grep -rn "expiry_date\|shelf_life" src/ migrations/` returns
  nothing; every `expires_at` in the schema is an auth token or an invitation. `inventory_lots`
  (`migrations/0006`) is a FIFO *cost* layer with no lot number and no traceability, and it is
  F&B-only.
- **No barcode.** `items.sku` and `inventory_items.sku` are text fields used for search
  (`src/lib/inventory-search.ts`); the single occurrence of the word "barcode" in the repo is a
  comment about scanner-speed typing at `src/app/dashboard/pos/pos-screen.tsx:802`.
- **No loyalty, no store credit, no promotions, no gift cards.** `customers`
  (`migrations/0001` + `0039_customers_directory.sql`) is `name, phone, address, notes, is_active`
  and nothing else — no email, no birthday, no tags, no balance. The only discount in the product is
  a manual per-order one (`orders.discount_type/discount_value`, `src/lib/order-totals.ts`).
- **No sales-staff commission.** Every "commission" in the codebase belongs to a consignor
  (`migrations/0055`) or an online platform (`0057`, `0060`); payroll (`0031`) is salary-only.
- **Nothing on the retail side of the item model can be purchased, returned or transferred.**
  `purchase-receipt-costing.ts`, `supplier-return-service.ts`, `transfer-service.ts`, reorder levels
  and write-downs all exist and are all `inventory_items`-shaped, so no jeweller, watch shop or
  accessories store has any of them.
- **Each trade's own signature workflows are missing.** A jeweller has no layaway (اقساط), cannot
  buy back a customer's old gold (آبشده / طلای دست‌دوم), and has no gram-denominated customer
  account (حساب طلایی). A watch shop cannot tell a customer their automatic is due for service, has
  no pre-owned intake, and no printed repair estimate — even though `repair_tickets`
  (`migrations/0067`) is already generic enough to serve jewelry too.

**Intended outcome:** cosmetics ships as a first-class trade, and each of the five trades gains the
handful of things that make the app feel built *for* that trade — with everything two or more trades
share built exactly once, on the `items` model, and switched on from `industry-profile.ts` rather
than from an `if (industry === …)` scattered through the app.

## Decisions

| Question | Decision |
|---|---|
| Cosmetics' item model | Reuse Phase 21's retail model exactly as accessories does — `items` (`variant_parent`/`variant_child` over shade × volume) + `item_stock`. **No new stock engine**, and F&B's `inventory_items` world is not touched |
| How stock with an expiry date is modelled | A new `item_batches` satellite plus `tracking='batch'` on `items`. For a batch-tracked item the batches are authoritative and `item_stock.quantity` is their rollup, asserted by an integration test rather than left as a convention |
| Where a shared capability is switched on | `src/lib/industry-profile.ts`. Anything with its own page + API prefix becomes a new `ModuleKey` (already enforced by `moduleForApiPath` in `withTenantScope`); anything living *inside* a trade's own module becomes an entry in a new `capabilities` field on `IndustryProfile` |
| Is `capabilities` a third guard axis? | **No.** It is read by the UI and by the trade's own service layer. Those routes are already gated by `requireIndustryForApi`, which is the stricter check — adding a third guard would be ceremony, not safety |
| Promotions for F&B and for retail | **One engine.** A pure `src/lib/promotions.ts` evaluated over a cart, called by both `order-totals.ts` and `retail-invoice-service.ts`, so one set of rules produces one answer. Three presets (ست هدیه, «۳ عدد», happy hour) over one implementation |
| Store credit and gift cards | Real liability accounts posted through the domain-event engine — never a number in a column |
| Jewelry layaway denomination | **Grams, not Rial**, so an instalment plan survives a gold-price move. This is how the trade actually works |
| Retail purchasing / returns / transfers | Built against `items`/`item_stock`/`item_batches`/`item_serials`, **mirroring** the F&B services' semantics. The two stock worlds still never merge — Phase 21's "Revised" decision stands |
| Does food_service get anything? | **Yes.** It is a business type like the others: happy-hour pricing through the shared promotion engine, recipe cost-drift alerts, waste analytics, and loyalty |

> **Risk recorded, then proceeding as decided.** This phase adds thirteen waves of surface to a
> platform whose tenant boundary is enforced by RLS. Every wave that adds a table adds its policy in
> the same migration, and `integration/tenant-isolation.integration.test.ts` is the gate — a failure
> there is a real bug, never a test to update.

## Architecture principles

1. **One place decides what a trade has** — `src/lib/industry-profile.ts`. Prefer adding to the
   profile over adding an `if (industry === …)` anywhere else.
2. **No second inventory subsystem.** Cosmetics reuses `items`/`item_stock`; F&B's
   `inventory_items`/`inventory_lots` engine is untouched.
3. **Ledger effects go through the posting engine** — `emitDomainEvent`
   (`src/lib/posting-engine.ts`) plus a rule registered in a `*-posting-rules.ts`. No new
   hand-written ledger function.
4. **Exact money on every posting path** — `src/lib/inventory-exact.ts` (`Decimal`/`RialText`,
   stage-by-stage `roundRial`), the convention `gold-pricing.ts` and `accessories.ts` already
   follow.
5. **Every new tenant-scoped table carries an RLS policy in the same migration**, scoped through
   `location_id` or through `items.location_id` (the pattern `item_stock` uses).
6. **Pure logic in `src/lib/*.ts` with a `*.test.ts` beside it**; DB orchestration in
   `*-service.ts`, always inside the caller's transaction.
7. **Migrations are forward-only.** `0048` is never edited; the industry `CHECK` is dropped and
   re-added in a new file.

---

# Track A — the new business type

## Scope — Wave 1: cosmetics & toiletries, wired end to end

The unglamorous half: the trade exists, provisions, and can sell.

- `migrations/00NN_cosmetics_industry.sql` *(new)* — drop and re-add the `businesses.industry`
  CHECK with `'cosmetics'` added. No backfill; every existing row keeps its value.
- `src/lib/industries.ts` — `cosmetics` in `INDUSTRIES`, `ENABLED_INDUSTRIES` and
  `INDUSTRY_LABELS` («آرایشی و بهداشتی»).
- `src/lib/coa-template.ts` — `COSMETICS_COA_TEMPLATE` modelled on `ACCESSORIES_COA_TEMPLATE`:
  `1350 موجودی کالای آرایشی و بهداشتی`, `4570 فروش لوازم آرایشی و بهداشتی`,
  `5150 بهای تمام‌شده کالای آرایشی و بهداشتی فروخته‌شده`, and `5160 کالای منقضی و تستر` for the
  write-offs Waves 2 and 3 post. Plus the `case` in `coaTemplateForIndustry`.
- `src/lib/industry-profile.ts` — the `cosmetics` module key and profile entry (brand
  «آرایشی و بهداشتی» / «مدیریت برند، بچ و تاریخ انقضا», `CORE_MODULES + "pos" + "cosmetics"`,
  `RETAIL_LABELS`, `salesModel: "retail_invoice"`,
  `defaultDisabledFeatures: ["inventory", "reservations", "delivery"]`) and its
  `PAGE_MODULE_PREFIXES` row.
- `src/lib/retail-invoice-service.ts` — a `cosmetic` line kind and its `LINE_KINDS_BY_INDUSTRY`
  entry; the line delegates to a new `sellCosmeticUnits` the way `sellAccessoryUnits` is used
  today, so no posting rule is duplicated.
- `src/lib/cosmetics.ts` *(new, pure)* — sale price, pack/unit price, running average cost, the
  `accessories.ts` shape — with `cosmetics.test.ts`. Plus `src/lib/cosmetics-service.ts` and
  `src/lib/cosmetics-posting-rules.ts`.
- `src/app/dashboard/cosmetics/page.tsx` *(new)* on the existing `industry-manager-shell.tsx`;
  `src/app/api/cosmetics/{items,reports}/route.ts` *(new)* behind `requireIndustryForApi`.
- `src/app/dashboard/pos/retail-invoice-screen.tsx` — a cosmetics catalogue branch.
- **Free by construction:** the platform console picker and `/welcome` both render from
  `ENABLED_INDUSTRIES`, so a super-admin can provision *and switch to* the new type with no change
  to `src/app/platform/industry-picker.tsx`. `wizardStepsForIndustry` already gives any
  non-`food_service` trade the reduced step set.
- Tests: extend `industries.test.ts`, `industry-profile.test.ts` (it asserts every industry is
  covered, has its own brand, and gets a selling screen), `coa-template.test.ts`, and the
  business-industry integration test.

## Scope — Wave 2: batch, expiry and FEFO

The capability that makes cosmetics a real trade rather than accessories with a new label.

- `migrations/00NN_item_batches.sql` *(new)* — `item_batches` (batch/lot number, expiry date,
  quantity, unit cost, received date, supplier reference) with its RLS policy, and `'batch'` added
  to the `items.tracking` CHECK.
- `src/lib/fefo.ts` *(new, pure)* — first-expired-first-out allocation across batches, unit-tested
  against partial-batch, short-stock and equal-expiry cases. The sell path consumes through it.
- Expired stock cannot be sold — refused in the service, not merely hidden in the UI.
- Near-expiry buckets (منقضی / زیر ۳۰ روز / زیر ۹۰ روز) on the trade's home page and as a report.
- A write-off path posting «کالای منقضی» through a domain event.
- Batch and expiry on the invoice line and the printed receipt — optional fields on the existing
  pure `receipt-template.ts`, the same way Phase 25 Wave 3 added the gold breakdown.
- New profile capability `batch_expiry`, on for `cosmetics`.

## Scope — Wave 3: cosmetics merchandising and regulatory identity

- `item_brands` (برند + کشور سازنده) and product line, so «برند» becomes a first-class filter,
  report axis and commission basis (Wave 7).
- Iranian-market regulatory fields per item — کد IRC / پروانه بهداشت and ثبت اصالت کالا — printed
  on the invoice when present.
- **Tester/sample stock**: open a sellable unit as a تستر and move its cost to a marketing expense
  account instead of COGS, through a domain event. The small, specific thing a cosmetics counter
  does every week that no generic POS models.
- **Shade/volume variant matrix editor** — bulk-create children over two axes on the existing
  `item_variant_attributes`.
- Skin/hair-type tags on items and on customers, feeding Wave 5's repeat-purchase engine.

---

# Track B — shared retail capability, built once

## Scope — Wave 4: barcode and label printing

*Capability `barcode` — all four retail trades.*

- `item_barcodes` (EAN/UPC/internal, many per item, unique per location), scan-to-add on the retail
  invoice screen, and generated internal barcodes for items that arrive without one.
- Label templates on the existing ESC/POS path (`src/lib/escpos.ts` plus the pure-template pattern
  of `receipt-template.ts`): price/shade/expiry for cosmetics, price/عیار/وزن for jewelry,
  price/size for accessories.

## Scope — Wave 5: loyalty, store credit and a customer worth having

*Module `loyalty`.*

- Extend `customers` with email, birthday, tags and consent. Already tenant-scoped — no new policy.
- `loyalty_programs` / `customer_points`, and **store credit as a real liability account** posted
  through the engine.
- **Repeat-purchase prediction** — per customer × product, from that customer's own history, giving
  the counter a «مشتریان آماده خرید مجدد» list. A shampoo is a 45-day cycle; this is the
  highest-value CRM feature cosmetics has, and every trade can use it.

## Scope — Wave 6: promotions, bundles and gift cards

*Module `promotions`.*

- `promotions` evaluated by a pure `src/lib/promotions.ts` over a cart, called by **both**
  `order-totals.ts` and `retail-invoice-service.ts`. Percent/amount off, buy-X-get-Y, bundle price,
  time-boxed.
- Three presets over one engine: ست هدیه for cosmetics, «۳ عدد» for accessories, happy hour for the
  café.
- `gift_cards` / vouchers with their own liability account and posting rule.

## Scope — Wave 7: sales-staff commission

*Module `commission`.*

- `commission_rules` per employee, per brand/category/trade — percent or fixed, on net or on
  margin. Attributed per invoice line to the selling employee through the existing
  shift/`created_by` chain, and accrued as a payroll liability via a domain event.
- Per-staff report and leaderboard. Cosmetics and jewelry counters run on this; nothing in the
  product models it today.

## Scope — Wave 8: purchasing, returns and transfers on the `items` model

The largest standing gap on the retail side. Build the same semantics as
`purchase-receipt-costing.ts`, `supplier-return-service.ts` and `transfer-service.ts` against
`items` / `item_stock` / `item_batches` / `item_serials` — mirroring, not merging, the two stock
worlds — plus reorder points and a low-stock / dead-stock report per trade.

---

# Track C — a flagship for each existing trade

## Scope — Wave 9: jewelry — layaway, buy-back, and the customer gold account

- **`layaway_plans` denominated in grams**, so an instalment plan survives a gold-price move.
  Posted through the engine. The single feature most likely to sell the product to a jeweller.
- **Buy-back / trade-in** (خرید طلای دست‌دوم و آبشده): a daily buy rate as a second role on
  `gold_prices`, an impurity/کسری deduction, and an intake creating a scrap `items` row with weight
  attributes.
- **حساب طلایی** — a per-customer *gram* balance subledger (طلب/بدهی وزنی) with its own account and
  a printable statement.
- **سفارش ساخت** (custom-order) tickets with a deposit and a promised date, reusing
  `repair_ticket_counters`' numbering pattern.

## Scope — Wave 10: watch — service CRM, pre-owned trade-in, provenance

- Service and battery **reminders** from `serial_warranties` plus sale date, surfaced as a due list
  and as a nudge through the existing `ai-proactive` job runner.
- **Pre-owned intake** with a condition grade and a box-and-papers checklist on the serial.
- Repair **estimate → customer approval → parts → close**, extending `repair_tickets` with an
  approval step and a printed estimate — and opening the repairs module to jewelry, since the table
  is already generic (`item_description`, nullable `serial_id`).

## Scope — Wave 11: accessories & cosmetics merchandising analytics

- Variant-matrix bulk price/stock editor; fast / slow / dead-stock classification; a markdown
  planner posting the write-down through `nrv-service.ts`'s existing shape.
- Season/collection tagging and sell-through reporting.

## Scope — Wave 12: food service — what the café gets

- **Happy-hour / time-of-day pricing** through Wave 6's engine, so there is no second discount path.
- **Recipe cost-drift alerts** — ingredient cost has moved more than X% since the menu price was set
  (`pricing-service.ts` + `inventory-costing.ts`).
- **Waste analytics** over the `inventory_events` waste postings that already exist.
- Wave 5's loyalty and repeat-visit turned on for F&B.

## Scope — Wave 13: close-out

- Per-trade report pack additions in `industry-reports.ts` and each `/api/{trade}/reports`.
- Teach the assistant the new tools (`src/lib/ai-tools.ts`) so «کدام کالاها تا ۳۰ روز دیگر منقضی
  می‌شوند؟» and «کمیسیون این ماه هر فروشنده چقدر است؟» answer.
- Phase doc close-out, `docs/phases/README.md` status row, and the `CLAUDE.md` industry paragraph
  updated to name five trades and the `capabilities` field.

---

## Out of scope

- Migrating `menu_items` / `inventory_items` / recipes onto the generic `items` model. Phase 21's
  recorded "Revised" decision stands, and Phase 25 restated it.
- A general i18n framework. `industry-profile.ts`'s label set grows only where a noun genuinely
  differs by trade.
- Any change to RLS mechanics or the Phase 23 subdomain/origin boundary.
- An external gold-price feed, weight-based FIFO costing for bulk gold, and coin (per-unit) pricing
  — still Phase 21's open product decisions.
- Holoo interoperability (Phase 26, issues #243–#252).

## Files at the centre of this

| File | Change |
|---|---|
| `src/lib/industries.ts` | fifth industry, label, enabled list |
| `src/lib/industry-profile.ts` | `cosmetics` profile; new module keys (`cosmetics`, `loyalty`, `promotions`, `commission`); new `capabilities` field |
| `src/lib/coa-template.ts` | `COSMETICS_COA_TEMPLATE` + `coaTemplateForIndustry` case |
| `src/lib/retail-invoice-service.ts` | `cosmetic` line kind; promotion evaluation |
| `src/lib/order-totals.ts` | calls the shared promotion engine |
| `src/lib/cosmetics.ts`, `cosmetics-service.ts`, `cosmetics-posting-rules.ts`, `fefo.ts`, `promotions.ts` | *(new)* pure logic, services and posting rules |
| `migrations/00NN_*.sql` | industry CHECK; `item_batches`; `item_barcodes`; `item_brands`; loyalty + store credit; promotions + gift cards; commission; retail purchasing/returns/transfers; jewelry layaway + gold account; watch pre-owned + estimates — **each with its RLS policy** |
| `src/app/dashboard/cosmetics/`, `src/app/api/cosmetics/` | *(new)* on `industry-manager-shell.tsx` |
| `docs/phases/README.md`, `CLAUDE.md` | index row; the industry paragraph |

## Exit criteria

1. A super-admin can provision a business as «آرایشی و بهداشتی» from the platform console, and it
   comes up with the cosmetics chart of accounts, its own brand block, and no café module.
2. A cosmetics business can receive stock in batches with expiry dates, is refused a sale of expired
   stock, sells FEFO, and sees a near-expiry list on its home page.
3. Every trade that has a barcode capability can scan an item onto an invoice and print a shelf
   label.
4. A customer earns and spends loyalty points and store credit, and store credit appears as a
   liability in the ledger.
5. One promotion engine produces the discount on both an F&B order and a retail invoice.
6. A commission accrual for a named employee appears in the ledger and on a per-staff report.
7. A jeweller can open a gram-denominated layaway plan, buy back scrap gold, and print a customer
   gold-account statement.
8. A watch shop gets a due-for-service list and can print a repair estimate for customer approval.
9. An F&B business is unchanged except for the features Wave 12 adds.
10. `integration/tenant-isolation.integration.test.ts` passes with every new table present.

## Verification

Per `CLAUDE.md`, from the repo root — these mirror the CI `test` job:

```bash
docker compose up -d && npm run db:migrate
npx tsc --noEmit
npm test
npm run test:db
npm run build
```

Each wave is its own commit and draft PR, watched through to merge per `CLAUDE.md`.
