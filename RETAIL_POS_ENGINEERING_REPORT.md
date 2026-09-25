# Retail POS Engineering Report

**Scope of this document.** The original brief for this engagement was a 91-point
spec for a full production-grade refactor of the retail POS flow under
`/accounting/pos` (jewelry, watch, cosmetics, accessories, and trade-goods
industries). This document reports **what was actually implemented and
verified**, across the whole engagement (spanning multiple working sessions on
this branch), against that brief. It does not claim anything beyond what is
in the diff and what the listed commands actually printed. Sections marked
**Not done** are gaps against the original 91-point spec, listed explicitly so
they are not mistaken for silent regressions.

Route scope did not change: `/accounting/pos` remains the sole canonical
retail POS route (`src/app/(app)/accounting/pos/page.tsx`); no duplicate route
was introduced or found.

---

## 1. Problems found (by code inspection, before any change)

1. **Reprint fidelity bugs** — the invoice detail/reprint path rebuilt a
   `ReceiptData` by hand from whatever the current `orders`/`order_items` rows
   held. Because `order_items.quantity` is hardcoded to `1` for every retail
   line (see §3), a reprint of a multi-unit accessory line showed quantity 1;
   the discount was hardcoded to `0`; the issue date was re-stamped with
   `new Date()` instead of the sale's real `orders.opened_at`/`closed_at`; gold
   weight/purity/making-charge/profit, watch serial/warranty, and cosmetics
   batch/expiry were not reliably recovered.
2. **First print used a second, independent code path** from reprint — the
   exact discount-0/`new Date()` bugs above were live on the *first* print too
   (`retail-invoice-screen.tsx`'s `submit()` hand-built a `ReceiptData` from
   the POST response), so first print and reprint could never be guaranteed
   to agree even after the reprint path was fixed.
3. **Jewelry defaults (اجرت 7%, سود 7%, مالیات 9%) were hardcoded as numeric
   literals** in four separate places inside `retail-invoice-screen.tsx`
   (the gold quick-add form, the barcode-scan quick-add, and duplicated again
   in the per-line preview), with no single source of truth and no
   configuration hook.
4. **No customer-required guard for credit sales.** `createRetailInvoice`
   accepted `paymentMethod: "credit"` with `customerId: null`, producing a
   receivable with nobody to collect it from — a real accounting-integrity
   bug, not a UX nicety.
5. **No hold-to-confirm on invoice submission.** The submit button was a plain
   `onClick`, one tap away from posting a financial transaction, unlike the
   café POS's payment button (`HoldToConfirmButton`, already used in
   `pos-screen.tsx`).
6. **The retail invoice detail view reused the café's `OrderDetailModal`**,
   which fetches `/api/tables` and `/api/menu` — neither of which a retail
   sale has — and reads a generic `getOrderDetail()` shape not suited to gold
   breakdowns, watch serials, or cosmetics batches.
7. **No persisted per-line retail snapshot.** Because `order_items.quantity`
   is folded to `1` and `unit_price` holds the whole line's net (a
   long-standing, correct-for-the-ledger design so retail's fractional/
   individually-priced lines never disagree with the ledger — see the
   `retail-invoice-service.ts` header), a historical read of `order_items`
   alone cannot recover a sold line's real quantity, discount split, or
   industry-specific fields.

## 2. Architecture — what was preserved, what was added

**Preserved, not rewritten:** the shared order/accounting engine
(`retail-invoice-service.ts`'s `createRetailInvoice`) — the atomic,
transactional, per-line posting through Phase 21's own sell services (gold,
watch, accessories, cosmetics, trade-goods) is untouched. A retail invoice
still opens an order row, posts each line through the industry's existing
sell service inside one transaction, and rolls back completely on any
failure. No rewrite of this engine was needed or done.

**Added — a dedicated read/print module**, `src/lib/retail-invoice/`:
- `types.ts` — the `RetailInvoiceDetail`/`RetailInvoiceDetailLine` shapes, one
  per industry line kind (gold/watch/cosmetic/accessory/stocked/legacy).
- `read-service.ts` — `getRetailInvoiceDetail()`, a dedicated read model that
  never calls `getOrderDetail()` and never fetches tables/menu.
- `print-data.ts` — `buildRetailInvoiceReceipt()` (pure function) and
  `getRetailInvoicePrintData()` (its DB-touching wrapper). This is now the
  **single canonical builder** for both first print and every later reprint
  (see §4).

**Added — a dedicated detail UI**, `retail-invoice-detail-modal.tsx`
(`RetailInvoiceDetailModal`), replacing `OrderDetailModal` on the retail
invoice-management screen. It is not a variant of `OrderDetailModal` and does
not share its data-fetching; per the standing constraint, restaurant and
retail only share low-level primitives (Dialog/Tabs primitives), not the
workflow component.

**Not done (module reorganisation):** the original spec's suggestion to
group retail POS into a `retail-pos/` component directory was not carried
out. `retail-invoice-screen.tsx` remains a single ~1,300-line file under
`src/app/dashboard/pos/`. This was a stated "ideally, time permitting" item;
time did not permit it this engagement. This is a structural/readability gap,
not a correctness one — see §9.

## 3. Data model change (migration `0174_retail_invoice_line_snapshot.sql`)

One column, additive and backward-compatible:

```sql
ALTER TABLE order_items ADD COLUMN retail_snapshot jsonb;
```

- **Non-destructive**: no existing column is altered or dropped; every
  pre-existing row gets `NULL` (every café/restaurant line, and every retail
  line written before this migration).
- **No fabricated backfill**: a historical retail invoice from before this
  column existed has no recoverable true quantity/discount split (it was
  never persisted); `getRetailInvoiceDetail()` falls back to the legacy
  `quantity`/`unit_price` columns for those rows and marks them
  `legacy: true` rather than inventing data. `RetailInvoiceDetailModal`
  surfaces this as a "legacy line" state rather than pretending full
  fidelity.
- **No new invoice-header table**: `orders` remains the one commercial
  transaction header; the snapshot lives on the line it describes.
- **Verified with a full clean migration run**: `npm run db:migrate` against
  a freshly `initdb`'d Postgres 17 cluster applied all 215 migrations,
  including this one, with no errors (see §8 for the exact run).

## 4. Unified print pipeline

`buildRetailInvoiceReceipt(detail, business)` is a pure function (no DB, no
`Date.now()`, no Next.js) of a `RetailInvoiceDetail`. `getRetailInvoicePrintData()`
loads that detail plus the business/location header and calls the pure
builder. Both:
- `GET /api/sales/invoices/[id]?view=print` (the reprint/detail-modal path), and
- `retail-invoice-screen.tsx`'s `submit()` (the first-print path, fixed this
  session — see §5.3)

call this one wrapper. The specific historical-fidelity bugs this fixes:
quantity (from the persisted snapshot, not the folded `order_items.quantity`),
gold weight/purity/making-charge/profit, watch serial/warranty, cosmetics
batch/expiry, customer name, the **original** `issuedAt` (the order's own
`opened_at`, never `new Date()`), and the **real** discount (from the
snapshot/detail, never hardcoded `0`).

Print retry never reposts the invoice: `printReceipt()` is a pure
print-side-effect call keyed by a stable `requestId`
(`invoice:${orderId}[:retry]`); nothing in the retry path calls
`POST /api/sales/invoices` again.

Printer-not-configured is explicitly excluded from the "print failed" warning
path (`result.error !== "printer_not_configured"`), matching the standing
requirement that a missing printer must not look like the sale failed. The
sale is committed and reported successful (`setDone(...)`) *before* the
print-data fetch or the print call runs, and a failure in either only ever
produces a non-blocking `toast.warning` with a retry action — it can never
un-commit or hide the completed sale.

## 5. This session's changes (on top of the prior sessions' work above)

### 5.1 Jewelry/retail pricing defaults — de-hardcoded to one place

Added `defaultRetailVatPercent(industry)`, `defaultGoldMakingChargePercent(industry)`,
`defaultGoldProfitPercent(industry)` to `src/lib/industry-profile.ts`, reading
from each industry profile's `retailDefaults` (already declared, e.g. jewelry:
`{ vatPercent: 9, goldMakingChargePercent: 7, goldProfitPercent: 7 }`), falling
back to 9%/7%/7% for an industry with no stated opinion. Every hardcoded `7`/
`9` literal in `retail-invoice-screen.tsx` (the gold quick-add form's initial
state, the barcode-scan quick-add for jewelry/cosmetics/accessories, and the
watch/accessory/cosmetics line forms) now reads through these helpers.

**Honest limitation**: this is an *industry-level* default, still a source
constant in `industry-profile.ts` rather than a runtime, per-business
setting. The originally requested resolution order (product → category →
industry → business) needs product/category-level override columns and a
settings UI that do not exist anywhere in this codebase yet (confirmed by
grep — no `makingChargePercent`/`goldSettings`/`jewelrySettings` table,
setting key, or UI exists). Building that is a real schema + UI feature, out
of scope for a bugfix pass within the remaining time; it is called out here
rather than silently left as still-hardcoded. What *was* achieved: one
canonical place per industry instead of four duplicated literals, with unit
test coverage (`src/lib/industry-profile.test.ts`).

### 5.2 Hold-to-confirm submission

Replaced the plain `<Button onClick={submit}>` with `HoldToConfirmButton`
(`durationMs={2000}`, Persian hold/cancel copy), the same component the café
POS uses for its payment button (4s there; 2s here, matching the brief's
"~2s" for retail). A tap that releases before 2s cancels and toasts why,
exactly like the café's; only a full, uninterrupted hold calls `submit()`,
and the button self-disables on `busy`.

### 5.3 First print now uses the canonical print pipeline

`submit()`'s success branch no longer hand-builds a `ReceiptData` (dropping
the `discount: 0` / `issuedAt: new Date().toISOString()` bugs at the source).
It now:
1. commits the invoice (unchanged `POST /api/sales/invoices`),
2. immediately marks the sale done and clears the cart (the UI reflects the
   committed sale regardless of what happens next),
3. fetches `GET /api/sales/invoices/${orderId}?view=print` — the same
   endpoint and the same `getRetailInvoicePrintData()` reprint uses — and
   prints *that* receipt.

A failure at step 3 (network error, `ordersView` permission gap — see the
limitation below, or a print failure) surfaces as a non-blocking
`toast.warning` with a "چاپ دوباره" retry action; it never undoes or hides
the completed sale.

**Honest limitation**: `POST /api/sales/invoices` requires
`PERMISSIONS.paymentsTake`; `GET .../[id]?view=print` requires
`PERMISSIONS.ordersView`. Every built-in role preset that grants
`paymentsTake` also grants `ordersView` (checked in `src/lib/permissions.ts`),
so this does not remove access for any shipped role. A fully custom role that
grants `payments.take` without `orders.view` (possible in principle via the
granular permission editor) would still complete the sale but the first-print
fetch would fail and fall back to the non-blocking warning — a corner case,
not a regression against the pre-existing reprint/detail-modal behaviour
(which already required `ordersView`), but worth a permission-preset audit
before this ships to a business with heavily customised roles.

### 5.4 Credit sales now require a customer (server-enforced, mirrored client-side)

`createRetailInvoice` now throws `RetailInvoiceError("برای فروش نسیه، انتخاب
مشتری الزامی است.")` when `paymentMethod === "credit"` and no `customerId` is
given — before any row is written (the check is the first thing after the
empty-invoice check, ahead of the order-number allocation). This is the
authoritative, server-side fix; the transaction is rolled back on this error
like every other `RetailInvoiceError`.

`retail-invoice-screen.tsx`'s `submit()` mirrors the same check client-side
(purely to save the round trip) and shows a hint under the customer picker
when credit is selected with no customer chosen.

### 5.5 Dead code removed

`useBusinessInfo()` (from `../use-printers`) became unused in
`retail-invoice-screen.tsx` once first print stopped hand-building its own
`ReceiptData` (which had used `business.name`/`address`/`phone`); the
now-dead `const business = useBusinessInfo()` and its import were removed.
Verified by grep that nothing else in the file references `business`; the
hook itself is still used elsewhere and was not touched.

## 6. Tests added or extended this session

| File | What it covers | Result |
|---|---|---|
| `src/lib/industry-profile.test.ts` (+3 tests) | The three new pricing-default helpers: jewelry reads its configured اجرت/سود/مالیات, an industry with no opinion falls back to 9/7/7, every industry returns a VAT default without throwing. | pass |
| `integration/retail-invoice.integration.test.ts` (+1 test, DB) | `createRetailInvoice` refuses a credit sale with no customer and writes no `orders` row. | pass |
| `src/app/dashboard/pos/retail-invoice-screen.test.tsx` (new, 4 tests) | (1) a plain tap on the submit control never posts the invoice; (2) a full 2s hold posts exactly once, then prints the server's canonical `ReceiptData` verbatim — asserted against a receipt whose discount and issue date could only have come from the server, not a client default; (3) a print-data fetch failure still shows the sale as completed and warns rather than blocking; (4) a credit sale with no customer is refused before any network call, showing the Persian message. | pass |

All four are exercised end-to-end at the component level (barcode scan → cart
line → hold gesture → mocked network), driving Vitest's fake timers through
the real `HoldToConfirmButton` pointer/animation-frame loop rather than
calling `onComplete` directly, so the assertions are about what actually
renders and fires, not internal state.

## 7. Existing test suites this session verified are unaffected

The credit-sale guard and the `retail-invoice-screen.tsx` rewiring touch
shared code (`retail-invoice-service.ts`, the invoice submit path). Everything
that imports either was re-run:

- `integration/retail-invoice.integration.test.ts` (13 tests) and
  `integration/trade-goods.integration.test.ts` (3 tests) — the only two
  integration suites that call `createRetailInvoice` (confirmed by grep)  — pass.
- The full unit suite (427 files / 5,975 tests) — pass, no change to
  restaurant/café POS behaviour (that path does not call
  `retail-invoice-service.ts`).
- A second, broader DB integration pass — `retail-invoice`,
  `closed-order-amendment`, `order-concurrency`, `order-customer`,
  `order-idempotency`, `order-line-modifiers`, `order-payment-channel-revenue`,
  `shift-closed-orders`, `shift-orders` (112 tests total) — pass, confirming
  the café/restaurant order engine (which the retail engine is built on top
  of) is unaffected.

## 8. Tool run results (exact commands, this session)

```
$ npm install                                   → 1095 packages, 0 errors
$ npm run db:migrate  (fresh initdb'd cluster)   → 215/215 migrations applied, 0 errors
$ npx tsc --noEmit -p tsconfig.json              → 0 errors
$ npx eslint .                                   → 0 problems
$ npx vitest run                                 → 427 files, 5975 tests, all pass (≈123s)
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts \
    integration/retail-invoice.integration.test.ts \
    integration/closed-order-amendment.integration.test.ts \
    integration/order-concurrency.integration.test.ts \
    integration/order-customer.integration.test.ts \
    integration/order-idempotency.integration.test.ts \
    integration/order-line-modifiers.integration.test.ts \
    integration/order-payment-channel-revenue.integration.test.ts \
    integration/shift-closed-orders.integration.test.ts \
    integration/shift-orders.integration.test.ts    → 9 files, 112 tests, all pass
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts \
    integration/trade-goods.integration.test.ts     → 1 file, 3 tests, pass
$ NODE_OPTIONS=--max-old-space-size=3200 npm run build
                                                  → compiled successfully, type-check passed,
                                                    full route manifest generated, 0 errors
```

`npm run build` needed an explicit V8 heap-size bump
(`--max-old-space-size=3200`) to complete inside this sandbox's 3.8 GB of RAM;
without it, Next's own "checking validity of types" pass (which duplicates
work `tsc --noEmit` already did cleanly) OOM-killed the build worker. This is
a sandbox resource constraint, not a code defect — `tsc --noEmit` against the
same `tsconfig.json` already reported zero errors, and the heap-bumped build
reached the same "0 errors" outcome. Documented here rather than silently
worked around, per the "no suppressions without a documented reason" rule —
nothing was suppressed; the build just needed more memory than this
particular container's default V8 old-space limit in a low-RAM environment.

## 9. Known limitations — explicitly NOT done this engagement

Being explicit that the original 91-point brief was much larger than what
shipped. Not done, in the order the brief recommended tackling them:

- **`retail-pos/` module reorganisation** — the component code is not moved
  into a dedicated directory; it still lives as one large file in
  `src/app/dashboard/pos/retail-invoice-screen.tsx`.
- **Full desktop/mobile UI redesign** — no rebuild of the product-area +
  sticky-cart-panel desktop layout or the mobile single-column/payment-sheet
  layout described in the brief. The existing two-column grid
  (`lg:grid-cols-[minmax(0,1fr)_22rem]`) and per-industry quick-add forms are
  unchanged in this engagement beyond the fixes in §5.
- **Line-editor dialogs** — cart lines are still added via always-mounted
  per-industry forms (`GoldLineForm`, `WatchLineForm`, `AccessoryLineForm`,
  `CosmeticsLineForm`), not modal line editors; existing cart lines cannot be
  edited in place (only removed) as far as this engagement verified.
- **Payment in a dedicated modal / split payment for retail** — retail still
  settles through one selected payment way per invoice
  (`ledgerSettlementFor` narrows to exactly one settlement per sale); no
  split-payment UI was added to the retail screen (the café POS's own split
  payment, `PaymentWays`, was not touched or extended to retail).
- **Under/overpayment handling, overpayment-to-credit, loyalty-triggers-
  customer-requirement** — not audited or implemented this engagement beyond
  the credit-requires-customer fix in §5.4.
- **Supervisor PIN for price/discount/tax/jewelly-charge overrides** — no
  such mechanism exists in the code; not built.
- **Invoice-management redesign** (rich filters, debounced/cancelable search,
  desktop table + mobile cards, export in multiple formats, server-side
  pagination) — mostly unchanged from prior sessions (debounced/cancelable
  search, method filter, desktop table + mobile cards, current-page CSV
  export, and rendering `RetailInvoiceDetailModal` instead of
  `OrderDetailModal` were already there). This session added the two filters
  that were still missing — invoice status (completed/voided) and a Jalali
  date range — end to end (server route, extracted service, and UI); see §11.
  Still **not** done: export of all-filtered/selected rows (only the current
  page exports), and any other filter/search UI beyond method/status/date/q.
- **Permission normalisation to `sales.invoice.*`** — not done; `grep` for
  `sales.invoice` in `src/lib/permissions.ts` returns nothing. The existing
  `orders.view`/`payments.take`/etc. identifiers are unchanged and untouched
  (so there is no access regression — nothing was renamed — but the
  requested semantic normalisation itself was not built).
- **Void/reversal flow audit** — not investigated this engagement; whether a
  "void a retail invoice" path exists, works, or is broken was not
  determined. Treat as unknown, not as "verified working."
- **RTL/accessibility/responsive-breakpoint audit** — not performed as a
  dedicated pass; the new `HoldToConfirmButton` wiring reuses an
  already-accessible component (aria-label with the hold instruction,
  keyboard Space/Enter support), but no systematic RTL or breakpoint sweep of
  `retail-invoice-screen.tsx` was done this engagement.
- **Manual/browser test scenarios** — the brief lists ten manual scenarios
  (normal sale, barcode, watch, jewelry, cosmetics batch, split payment,
  credit, printer missing, printer retry, mobile @390px). **None of these
  were run through an actual browser this session.** What stands in for them
  is: (a) the automated component test in §6, which drives a real barcode
  scan → cart → hold-to-confirm → mocked print for the accessories industry,
  and a real credit-without-customer rejection; (b) the DB integration tests
  in §7, which exercise real gold/watch/cosmetics/accessory sell services
  end-to-end against Postgres, including the historical fidelity fields. That
  is meaningful coverage of the underlying logic, but it is not the same as
  clicking through the live app at 390px with a real printer absent — that
  was not attempted and should not be treated as verified.

## 10. Summary

This engagement preserved the existing shared order/accounting engine,
added a dedicated retail read/print module and detail-modal UI that no longer
depend on the café's `getOrderDetail()`/`OrderDetailModal`/tables/menu, and
persisted an immutable per-line retail snapshot via one additive, non-
destructive migration. This session's increment on top of that: unified first
print onto the same canonical pipeline reprint already used (removing the
discount-0/`new Date()` bugs at their source on the create path, not just the
read path), de-hardcoded the jewelry/VAT defaults to one industry-level
source, added a hold-to-confirm gesture to invoice submission, closed a real
accounting-integrity gap (credit sales with no customer), and added targeted
automated tests for all of the above. `npx tsc --noEmit`, `npx eslint .`, the
full unit suite, the relevant DB integration suites, and `npm run build` all
pass as of this report. The items in §9 remain open against the original
91-point brief and are not claimed as done.

## 11. Follow-up session — invoice-management status & date-range filters

`invoice-management-view.tsx` (the «مدیریت فاکتورها» screen) let a cashier
filter sales history by payment method and free-text search, but could not
filter by invoice status (completed vs. voided) or by a date range, even
though the underlying `orders` table already carries both. This closes that
specific gap from §9's list — it is not the full invoice-management redesign
the original brief described (no all-filtered/selected export, no additional
filters beyond what's listed below).

**Server (`src/app/api/sales/invoices/route.ts` GET handler):**
- New optional query params: `status` (`completed` | `voided` | omitted =
  all; 400 `invalid_invoice_status` otherwise — renamed from an initial
  `invalid_status` to avoid colliding with the floor-plan table-status error
  code already registered under that name in the shared `ERROR_MESSAGES` map)
  and `dateFrom`/`dateTo` (ISO `YYYY-MM-DD`, matched against the location's
  Jalali/local business-day boundary via the existing `app_business_date()`
  DB function from migration `0076_business_day.sql` — the same function the
  rest of the ledger already uses for date filters, so "today" means the same
  thing here as everywhere else in the app). Malformed dates or `dateFrom` >
  `dateTo` return 400 `invalid_date`/`invalid_date_range` (both already
  Persian-mapped, reused from the ledger's existing filter errors).
- **Extracted** the route's inline SQL query and row-mapping into a new,
  independently testable service: `src/lib/retail-invoice/list-service.ts`
  (`listRetailInvoices()`). Reason: this GET route had no integration test
  before this change, and the codebase's established convention (see the
  other `integration/*.test.ts` files) is to test service functions directly
  against a real database rather than reconstruct a `NextRequest`/session to
  test a route handler in isolation. The route itself is now a thin
  validate-params-then-call-the-service-then-format-JSON layer.
- **Bug fixed, found only via the new test**: the status filter's SQL
  (`o.status = $8`) failed with `operator does not exist: order_status =
  text` — Postgres would not implicitly compare its `order_status` enum
  column against a bound `text` parameter. Fixed with an explicit
  `o.status::text = $8` cast.

**Client (`invoice-management-view.tsx`):**
- Added a status filter as chips (همه وضعیت‌ها / تکمیل‌شده / باطل‌شده),
  matching the existing method-filter-chip pattern exactly (`chipClass`,
  `role="group"`, `aria-pressed`).
- Added two `JalaliDatePicker`s (از تاریخ / تا تاریخ), the same component and
  layout convention `entries-section.tsx` (the journal's own date-range
  filter) already uses, so a cashier picks Jalali dates while the client
  stores/sends Gregorian ISO strings underneath — consistent with the rest of
  the app.
- Both new filters participate in the existing debounce/cancel/page-reset
  machinery unchanged (added to the same `useEffect` dependency arrays that
  already reset `page` to 1 and re-fetch on filter change).
- Added the two new server error codes to the shared `ERROR_MESSAGES` map in
  `src/app/dashboard/ui.tsx` (`invalid_invoice_status`, `invalid_date_range`)
  so they render as the same Persian message convention every other filter
  error in the app uses.

**Tests added:**
- `integration/retail-invoice-list.integration.test.ts` (new, 3 tests, real
  DB) — status filter, Jalali date-range filter (backdates an order's
  `closed_at`/`status` directly via SQL to simulate a historical/voided
  invoice, since no void or backdating API exists yet), and pagination/count
  correctness across pages. Self-contained: its own scratch database
  (`pos_retail_invoice_list_<uuid>`), not sharing state with the sibling
  `retail-invoice.integration.test.ts`.
- `src/app/dashboard/pos/invoice-management-view.test.tsx` (new, 5 tests,
  jsdom + fake timers + a stubbed `fetch`) — default load sends no
  status/date params; selecting a status chip sends `status=voided` and
  resets to page 1; re-selecting «همه وضعیت‌ها» clears it; setting both date
  pickers to «امروز» sends `dateFrom`/`dateTo` as ISO dates; a server
  `invalid_date_range` response renders the mapped Persian message.

**Tool run results (this follow-up):**
- `NODE_OPTIONS="--max-old-space-size=3200" npx tsc --noEmit -p tsconfig.json`
  → 0 errors.
- `npx eslint` on every file touched or added in this follow-up → 0
  errors/warnings.
- `npx vitest run` (full unit suite) → 428 files, 5980 tests, all pass (no
  regressions from the `ui.tsx` error-map addition or the route extraction).
- `DATABASE_URL=... npx vitest run --config vitest.db.config.ts
  integration/retail-invoice.integration.test.ts
  integration/retail-invoice-list.integration.test.ts
  integration/trade-goods.integration.test.ts` → 19/19 pass (the pre-existing
  13 + 3 retail-invoice-list tests + the unrelated 3 trade-goods tests, run
  together to confirm the route extraction didn't regress the sibling
  suites).
- `NODE_OPTIONS="--max-old-space-size=4096" npx next build` → succeeds, no
  new errors or warnings attributable to this change.

**Not done in this follow-up** (unchanged from §9): export of
all-filtered/selected rows (still current-page-only CSV), any filter beyond
method/status/date/free-text search, and everything else §9 already lists as
out of scope.
