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
- **Payment in a dedicated modal for retail** — retail still settles inline
  on the invoice screen, not in a separate modal dialog. Split payment
  itself is now supported (§15): a retail invoice can tender across up to
  `MAX_RETAIL_TENDERS` ways, matching the café's own multi-way settlement in
  spirit though not in the same code path (retail has no single order total
  to settle in one journal entry — see §15.1 for why it could not simply
  reuse the café's `PaymentWays`).
- **Under/overpayment handling, overpayment-to-credit, loyalty-triggers-
  customer-requirement** — not audited or implemented this engagement beyond
  the credit-requires-customer fix in §5.4 (which §15's split-tender queue
  also respects — any slice that resolves to `credit` still requires a
  customer, see §15.2).
- **Supervisor PIN for price/discount/tax/jewelly-charge overrides** — no
  such mechanism exists in the code; not built.
- **Invoice-management redesign** (rich filters, debounced/cancelable search,
  desktop table + mobile cards, export in multiple formats, server-side
  pagination) — mostly unchanged from prior sessions (debounced/cancelable
  search, method filter, desktop table + mobile cards, and rendering
  `RetailInvoiceDetailModal` instead of `OrderDetailModal` were already
  there); an earlier follow-up session added invoice status
  (completed/voided) and a Jalali date range (§11). This session added the
  full filtered-set CSV export (§16.3) and fixed a related display/filter
  bug where a split-payment invoice's other tender(s) were invisible to both
  the list and the method filter (§16.1–§16.2). Still **not** done: any
  filter/search UI beyond method/status/date/q (no per-cashier or
  per-customer filter, no amount-range filter).
- **Permission normalisation to `sales.invoice.*`** — not done; `grep` for
  `sales.invoice` in `src/lib/permissions.ts` returns nothing. The existing
  `orders.view`/`payments.take`/etc. identifiers are unchanged and untouched
  (so there is no access regression — nothing was renamed — but the
  requested semantic normalisation itself was not built).
- **Void/reversal flow audit** — investigated in the follow-up session in
  §12: a "void a retail invoice" UI was built, then found broken by
  inspection and empirical test before being shipped, and reverted rather
  than exposed. See §12.1 for the root cause and why it was reverted instead
  of fixed in place.
- **RTL/accessibility/responsive-breakpoint audit** — a scoped pass over the
  three retail invoice screens (not a systematic sweep of the whole app) was
  done in a later follow-up; see §18. It found and fixed one concrete WAI-ARIA
  violation (the payment-way radiogroup had no keyboard support) and confirmed
  the rest of these screens already follow the app's established RTL/a11y
  conventions correctly. No responsive-breakpoint sweep (e.g. manually
  checking 390px) was performed either time — that remains open.
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

## 12. Follow-up session — void/reversal audit (not shipped) + a separate, more severe repeat-sale posting bug found and fixed

This session's task was to resolve §9's "void/reversal flow audit — not
investigated" gap: audit whether voiding a retail invoice works, and either
fix it or hide it if it's broken. That audit surfaced two distinct findings,
handled differently below.

### 12.1 Void UI: built, then reverted before shipping — do not re-attempt without first fixing the reversal engine

A void/reversal UI was implemented this session across four files
(`src/app/(app)/accounting/pos/page.tsx`, `retail-invoice-screen.tsx`,
`invoice-management-view.tsx`, `retail-invoice-detail-modal.tsx`), reusing
the existing, unmodified backend
(`POST /api/orders/[id]/amend` → `order-amendment-service.ts`'s `voidOrder()`)
with zero backend changes — the same amend/reversal engine the café POS
already uses for voiding a restaurant order. It passed typecheck and its own
new component tests.

**Before shipping it, a closer read of `order-amendment-service.ts` found the
reversal it performs is scoped to `source_type IN ('order',
'order_amendment')` only** — it finds "live" (unreversed) journal postings for
an order by that filter and reverses each one. That is correct for the
café/restaurant flow, where every payment/COGS posting for an order is
written with exactly that `source_type`.

**It is not correct for any retail invoice.** Every retail sale line, for
every industry, is written through `retail-invoice-service.ts`'s
`createRetailInvoice()` → `settleLine()`, which delegates to one of five
industry-specific sell services — `gold-sales-service.ts`,
`watch-sales-service.ts`, `accessories-service.ts`, `cosmetics-service.ts`,
`trade-goods-service.ts` — none of which ever writes `source_type = 'order'`.
They post under their own industry tags instead: `gold_sale`, `watch_sale`,
`accessory_sale`, `cosmetic_sale`, and `{wholesale|tools_fittings|
haberdashery}_sale`. **`livePostings()`'s query can never see any of these
rows**, for any industry, for any retail invoice, ever.

Consequence, confirmed empirically (not just by code inspection): a
throwaway integration test (`integration/retail-invoice-void.integration.test.ts`,
written, run, and then deleted along with the reverted UI once this was
confirmed) created a retail gold-sale invoice, called `voidOrder()` on it,
and read back the original `gold_sale_revenue`/`gold_sale_cogs` journal
entries — both still had `reversed_at: null` and `reverses_entry_id: null`.
The order's own status flips to voided, but the revenue, COGS, and inventory
effects of the original sale are completely untouched. A user would see an
invoice marked "باطل شده" while the books and stock levels still reflect the
sale exactly as if it had never been voided — a silent, dangerous state to
ship, not a cosmetic gap.

There is no safe subset to expose: because every retail line of every
industry routes through the same `settleLine()` → industry-sell-service path,
this affects **100% of retail invoices**, not just gold or just high-value
items. Gating the void button to "only industries where it happens to be
safe" was considered and rejected — there is no such industry; all five are
equally affected.

**Decision: the void UI was reverted in full** (`git checkout --` on all four
files, discarding every void-related edit; the throwaway test and a scratch
reproduction script were deleted, not committed). Nothing about void/undo was
shipped this session. This is the "hide it" half of the task's own explicit
"audit + fix OR hide" instruction, chosen over "fix" because a correct fix is
materially larger than a bugfix pass: it needs (a) the reversal engine taught
to find and reverse the industry-specific postings, which — because an
accessory/cosmetic item is resold across many separate invoices, unlike a
one-off gold piece — cannot be found by re-deriving them from `item_id` at
void time; it needs each line's *actual* posted entry ids captured at
sale time. `order_items.retail_snapshot` (migration `0174`, already shipped,
additive) is the natural place to persist them, since every sell-service
already returns `revenueEntryId`/`cogsEntryId` from its `emitDomainEvent`
calls. It also needs (b) an inventory-quantity restoration step for these
industries, since `item_stock.quantity` is decremented at sale time with no
existing "undo" path in the amendment flow. Both are real, scoped,
additive-only engineering work that deserves its own dedicated implementation
and test pass, not something to rush to completion inside an unrelated
audit-and-bugfix session. **Recommendation for whoever picks this up next:**
build (a) and (b) above, add a dedicated void-reversal integration test per
industry (gold/watch/accessory/cosmetic/trade-goods) asserting the original
entries end up reversed and stock is restored, *before* re-adding any void UI.

### 12.2 A separate, more severe, pre-existing bug found and fixed: repeat sale of the same accessory/cosmetic/trade-goods item crashed

While tracing the sell-service posting code for the audit above, a second,
unrelated, already-live production bug was found and empirically confirmed
with a disposable probe script (not committed): **selling the same
accessory, cosmetic, or trade-goods item twice, in two separate
transactions/invoices, throws instead of succeeding.**

**Root cause.** `posting-engine.ts`'s `emitDomainEvent()` passes its
`sourceId` straight through onto the `journal_entries` row it posts.
`journal_entries` carries a unique index, `uq_journal_business_source_posting`
(migration `0012_inventory_accounting_integrity.sql`), on `(business_id,
source_type, source_id, posting_kind)`. `accessories-service.ts`'s
`sellAccessoryUnits`, `cosmetics-service.ts`'s `sellCosmeticUnits` (its sale
path only), and `trade-goods-service.ts`'s `sellTradeGoodsUnits` each called
`emitDomainEvent` with a **fixed** `sourceId: input.itemId` — the same value
on every sale of that item. The *first* sale of an item posted fine; the
*second* sale of the same item, with the same `source_type` and the same
fixed `posting_kind` (e.g. `accessory_sale_revenue`), collided with the first
sale's row and threw a raw, unhandled `duplicate key value violates unique
constraint "uq_journal_business_source_posting"` straight out of Postgres.
This is exactly the ordinary case for fungible retail stock — an accessory or
a lipstick is meant to be sold to many different customers, in many separate
invoices — so this was not an edge case; it was a landmine under every
single accessory/cosmetics/trade-goods SKU the moment it sold twice.

**Why this was never caught before:** `integration/accessories.integration.test.ts`'s
entire `sellAccessoryUnits` test suite (read in full) never sold the same
item more than once across its test cases, so the collision had no chance to
surface. `cosmetics-service.ts` had **no dedicated integration test file at
all** prior to this session.

**Fix.** The naive fix — replacing `sourceId: input.itemId` with a fresh
`randomUUID()` per sale — was tried first and immediately caught by running
the *full* test suite (not just the touched files): it broke
`industry-reports-service.ts`'s `variantSalesAnalysis()` report, which reads
`domain_events.source_id` directly, groups by it, and joins it against
`items.id` — i.e. it depends on `source_id` being the item's id for these
event types. `journal_entries.source_id` and `domain_events.source_id` were
previously always the same value by construction (`dispatchDomainEvent()`
copies one straight from the other), so there was no way to fix one without
breaking the other under the old plumbing.

The actual fix adds one small, additive, backward-compatible knob to the
shared posting engine rather than touching that coupling everywhere it's
relied on:

- `posting-engine.ts`: `RecordDomainEventInput` gains an optional
  `postingSourceId?: string | null`. `dispatchDomainEvent()` now accepts an
  optional override parameter and uses it for `journal_entries.source_id`
  (falling back to `event.sourceId`, i.e. the old behaviour, when omitted).
  `emitDomainEvent()` threads `input.postingSourceId` through. Every other
  call site across the codebase (35+ `emitDomainEvent` callers) that doesn't
  pass this new field is byte-for-byte unaffected.
- `accessories-service.ts`, `cosmetics-service.ts` (sale path only),
  `trade-goods-service.ts`: each `sellX()` now generates one
  `postingSourceId = randomUUID()` per sale call and passes it to both the
  revenue and the COGS `emitDomainEvent()` calls (same posting kind never
  repeats within one sale, so sharing it between the two is safe and keeps
  them traceable to the same sale). `sourceType`/`sourceId` on the
  `domain_events` row are **unchanged** — still `input.itemId` — so
  `variantSalesAnalysis()`, `itemAuditTrail()`, and anything else that reads
  the event log by item id keep working exactly as before.

**Explicitly NOT fixed in this pass (flagged risks, not silently assumed
safe):**
- `cosmetics-service.ts` has the identical `sourceId: input.itemId` defect in
  two more places: `cosmetic_write_off` (~line 394) and `cosmetic_tester`
  (~line 658) — i.e. as the code stood before *and after* this fix, a
  cosmetic item can still only ever be written off, or have a tester bottle
  opened, once, ever; a second write-off or tester-open of the same item will
  still crash with the same unique-constraint violation. Not fixed here
  because it is a distinct code path with its own semantics, deliberately
  kept out of a same-session bugfix scope.
- A codebase-wide grep found 35+ other `emitDomainEvent(` call sites (in
  `loyalty-service.ts`, `repairs-service.ts`, `jewelry-flagship-service.ts`,
  `item-stock-count-service.ts`, `commission-service.ts`,
  `consignment-service.ts`, `merchandising-service.ts`,
  `message-cost-posting.ts`, `production-service.ts`, `promotions-service.ts`,
  `retail-stock-service.ts`, `retail-warehouse-document-service.ts`,
  `warehouse-document-service.ts`, `waste-service.ts`, and others). None of
  these were audited for the same "fixed, reusable sourceId" defect class in
  this pass — that would be a broad, unrelated refactor across the whole
  ledger surface, explicitly out of scope for this task. **Recommended
  follow-up**: grep every `emitDomainEvent(` call for a `sourceId` derived
  from a reusable entity (an item, a customer, a table) rather than a
  one-shot transaction/event id, and apply the same `postingSourceId`
  pattern where needed.
- `gold-sales-service.ts` and `watch-sales-service.ts` use the same
  `sourceId: input.itemId`/`serial.id` pattern and were **left untouched**:
  `tracking: 'weight'` (gold) and `tracking: 'serial'` (watch) items are
  normally one-physical-unit-per-row, sold exactly once, so `sourceId =
  itemId` is unambiguous in the ordinary case — unlike accessories/cosmetics/
  trade-goods, which are explicitly fungible, resellable stock. Whether a
  gold buyback-then-relist or a watch return-then-resell flow could still
  trigger the same collision was **not verified** either way; flagged here as
  an open, unaudited risk rather than assumed safe.

**Tests added:**

| File | What it covers |
|---|---|
| `integration/accessories.integration.test.ts` (+1 test) | Sells the same accessory item twice in two separate transactions; asserts distinct revenue/COGS entry ids, both entries have real journal lines, stock is relieved correctly across both sales, and exactly 4 `journal_entries` rows exist with `source_type = 'accessory_sale'`. |
| `integration/trade-goods.integration.test.ts` (+1 test, run once per each of the three trade industries via the existing `describe.each`) | Sells the same trade-goods item across two separate `createRetailInvoice()` calls (the real production entry point, not just the sell-service directly); asserts both invoices succeed, stock is relieved correctly, and 4 journal entries post per industry. |
| `integration/cosmetics-sale-idempotency.integration.test.ts` (new file, 1 test) | `cosmetics-service.ts` had no integration test file at all before this change. This is a narrow, purpose-built regression test proving the fix — not an attempt at full coverage of `cosmetics-service.ts`, which remains otherwise untested at the integration level. |

**Tool run results (this follow-up):**
```
$ npx tsc --noEmit                                          → 0 errors
$ npx eslint <every file touched this session>              → 0 problems
$ npx vitest run                                             → 428 files, 5980 tests, all pass
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts
    (every integration test file in the repo, all 134 files)  → 134 files, 1533 tests pass, 1 pre-existing skip
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts \
    integration/accessories.integration.test.ts \
    integration/trade-goods.integration.test.ts \
    integration/cosmetics-sale-idempotency.integration.test.ts \
    integration/industry-reports.integration.test.ts \
    integration/retail-invoice.integration.test.ts \
    integration/retail-invoice-list.integration.test.ts        → 6 files, 46 tests pass
```
The `industry-reports.integration.test.ts` run is the one that matters most
here: it is the test that caught the naive first attempt at this fix
(breaking `variantSalesAnalysis`) and now passes cleanly with the corrected
`postingSourceId` approach — confirming the decoupling works as intended.

**Net diff this follow-up:** `posting-engine.ts`, `accessories-service.ts`,
`cosmetics-service.ts`, `trade-goods-service.ts` (the fix), plus the three
test files above. No void/undo UI, no backend amendment-engine changes, and
no changes to gold/watch sale code shipped this session.

## 13. Follow-up session — closing out §12's flagged risks: a full audit of every posting call site, three more confirmed-and-fixed bugs, and gold/watch cleared

§12 flagged three risks as unaudited rather than fixed: the identical defect
in `cosmetics-service.ts`'s write-off/tester paths, the other 35+
`emitDomainEvent` call sites across the codebase, and whether gold/watch's
one-unit-per-row assumption actually holds. This session closed out all
three: audited every one of them by reading the code (not just grepping the
pattern), fixed three more confirmed, real bugs of the exact same shape, and
verified gold/watch structurally cannot hit this defect at all.

### 13.1 Gold and watch: verified safe, not merely assumed

`sellWeightedItem` (`gold-sales-service.ts`) refuses to sell a `weight`-tracked
item unless `item_weight_attributes.status === 'in_stock'`, and
`validateWeightItemStatusTransition` (`items.ts`) hard-blocks any transition
*out of* `'sold'` — "کالای فروخته‌شده را نمی‌توان به وضعیت دیگری بازگرداند"
("a sold item can never be returned to another status"). `setWeightItemStatus`
is the *only* function that ever writes this column, and it is called only
from `sellWeightedItem` itself, to set `'sold'`. So a specific weighed piece
can post its `gold_sale` revenue/COGS entries **at most once, ever** — not "in
the ordinary case," but as a hard invariant enforced by the state machine.
`sellSerializedUnit` (`watch-sales-service.ts`) has the identical shape for
`item_serials.status` via `validateSerialStatusTransition`, which has the
identical `'sold'`-is-terminal rule, and nothing anywhere in the codebase
(checked by grepping every `UPDATE item_serials ... SET status` and every
`UPDATE item_weight_attributes ... SET status`) ever resurrects a sold unit
back to a sellable state — `repairs-service.ts` only ever moves a serial
between `in_stock` and `in_repair`, never touching `sold`. Gold buy-back
(`buyBackGold` in `jewelry-flagship-service.ts`) is not a relisting of a
previously sold item either: it calls `createItem(...)` to mint a **brand
new** item row for the scrap gold the shop just bought, so its `sourceId` is
naturally unique per buy-back. **Conclusion: gold and watch sales cannot hit
this bug class, structurally, not just in every case tested.** No code
change was needed or made to either file.

### 13.2 Three more confirmed, real, previously-undiscovered bugs of the identical shape — fixed

Auditing every `emitDomainEvent(` call site in the codebase (20 files, all
read in full, not just grepped) found three more places with the exact same
defect as §12.2's accessories/cosmetics/trade-goods sale bug: a **fixed**
`sourceId` reused across postings that are supposed to happen more than once
for the same entity, colliding on `uq_journal_business_source_posting`. Two
are gift cards and consignor payouts — both are certain, not
theoretical-edge-case bugs, because *partial, repeated use is the entire
point of both features*:

| File / function | Entity reused as `sourceId` | Why a second use is certain, not an edge case | Confirmed previously undiscovered because |
|---|---|---|---|
| `promotions-service.ts` `redeemGiftCard` | `card.id` | `giftCardBalance()` explicitly sums *every* past `gift_card_redeemed` event for a card — partial, multi-transaction redemption is the feature's whole design. | `integration/promotions.integration.test.ts` redeemed each of its two test cards exactly once. |
| `consignment-service.ts` `payConsignor` | `input.consignorId` | The function's own doc comment: "Settles **part or all** of a consignor's balance" — a consignor payable is explicitly meant to be paid down over several separate payouts. | Both existing tests (`industry-reports.integration.test.ts`) created a fresh consignor per test and paid each out exactly once. |
| `cosmetics-service.ts` `writeOffExpiredBatches` / `openTester` | `input.itemId` | Flagged in §12.2 already; fixed this session. A shop writes off newly-expired batches of the same SKU repeatedly over its shelf life, and opens more than one tester bottle of a popular item over time. | No integration test file for `cosmetics-service.ts` existed before §12.2; the new one only covered the sale path until this session. |

Also found, same shape, **caught before shipping** by re-reading the full
test suite result each time (not assumed safe from the pattern alone):
`merchandising-service.ts`'s `applyMarkdown` posted `item.markdown_write_down`
with `sourceType: "item", sourceId: input.itemId` — and slow-moving stock is
routinely marked down more than once over its shelf life (a second markdown
of the same item, e.g. from 100,000 → 80,000 → 60,000 Rial as it keeps not
selling, is an entirely ordinary merchandising action, not a corner case).
Fixed with the same `postingSourceId` pattern.

**The fix, in each case:** identical to §12.2 — keep `domain_events.source_id`
carrying the real entity id (what every report/statement/balance
reconstruction reads: `giftCardBalance()` reads `payload->>'giftCardId'`,
`getConsignorStatement()` reads `payload->>'consignorId'`, `itemAuditTrail()`
reads `payload->>'itemId'`/`source_id` — none of these were touched), and
pass a fresh `postingSourceId: randomUUID()` so each individual posting gets
its own identity against `uq_journal_business_source_posting`. Confirmed
before applying each fix that nothing joins `journal_entries.source_id`
against these ids for these `source_type`s (only `ledger-source-labels.ts`,
a fixed Persian label lookup, as established in §12.2).

### 13.3 Every other posting call site: read, and confirmed already safe — with the specific reason for each

The remaining 15 files with `emitDomainEvent(` calls were each read in full,
not spot-checked, and every one relies on one of three already-sound patterns
— so none needed a change:

- **A fresh id minted immediately before the call, every time** (the same
  shape as this session's fix, already applied by whoever wrote it):
  `production-service.ts` (`runId = randomUUID()`), `loyalty-service.ts`'s
  `redeemPoints`/`issueStoreCredit`/`useStoreCredit` (all `randomUUID()`
  already), `item-stock-count-service.ts` (`countId`/`reversalId` are the
  `id` `RETURNING` from a fresh `INSERT` right before use), `waste-service.ts`
  (a fresh `inventory_events` row per waste event, plus its own explicit
  `idempotency_key` de-dup), `retail-warehouse-document-service.ts` and
  `warehouse-document-service.ts` (`documentId` from a fresh `INSERT`),
  `retail-stock-service.ts`'s `purchaseId`/`returnId` (same), and
  `jewelry-flagship-service.ts`'s `buyBackGold` (a freshly created item, see
  §13.1) and `custom_order_ticket` deposit (posted once, at ticket-creation
  time, off a freshly inserted ticket row).
- **A status machine that makes the entity's terminal state genuinely
  one-shot**, the same discipline as gold/watch in §13.1:
  `repairs-service.ts`'s `closeRepairTicket` (`validateRepairStatusTransition`
  hard-blocks leaving `'closed'`, and `setRepairStatus`'s own doc comment says
  "closed is deliberately unreachable here"), `retail-stock-service.ts`'s
  `shipItemTransfer`/`receiveItemTransfer` (`draft → shipped → received`, each
  step throws "قبلاً ارسال شده"/"قبلاً دریافت شده" — already sent/received —
  on a repeat call), and `jewelry-flagship-service.ts`'s `completeLayaway`
  (requires `status === 'open'`, sets `'completed'`, no code path reopens a
  plan).
- **An explicit idempotency/claim guard**: `message-cost-posting.ts`'s
  `postCompletedCampaignCost` claims the posting with an atomic
  `UPDATE ... SET cost_posted = true WHERE cost_posted = false RETURNING id`
  before posting, and unclaims it on failure so a retry can still post —
  textbook exactly-once semantics, unrelated to this bug class.
- **A caller-supplied id that is already naturally unique per event**:
  `commission-service.ts`'s `accrueCommissionForLine`, called from
  `retail-invoice-service.ts` with `sourceId: itemRows[0].id` — the
  `order_items` row id, which is a fresh row per invoice line, not the
  catalog item id.

**One pattern noted but deliberately left unchanged, as a documented
maintenance risk rather than a bug**: `jewelry-flagship-service.ts`'s
`recordGoldAccountMovement` takes an optional caller-supplied `sourceId` that
defaults to `null`; `uq_journal_business_source_posting` is a partial index
(`WHERE source_id IS NOT NULL`), so a `null` source_id is exempt from the
constraint entirely, and correctly so today — the only caller
(`/api/jewelry/gold-account/route.ts`) never passes a non-null value. This is
*correct as currently used*, not a bug, so it was not changed; but if a
future caller starts passing a reusable, non-null `sourceId` here, the same
defect class would reappear. Flagged for whoever touches this function next.

### 13.4 Tests added this session

| File | What it covers |
|---|---|
| `integration/promotions.integration.test.ts` (+1 test) | Redeems the same gift card twice, in two separate transactions; asserts both post independent entries, the balance is correct after both, and exactly 3 `journal_entries` rows exist (1 issue + 2 redemptions). |
| `integration/industry-reports.integration.test.ts` (+1 test, in the "consignor statement and payout" describe block) | Pays out the same consignor twice, in two separate transactions; asserts both post independent entries and `totalPaid`/`balance` are correct after both. |
| `integration/cosmetics-sale-idempotency.integration.test.ts` (+2 tests: `writeOffExpiredBatches`, `openTester`) | Writes off two separate expired batches of the same item on two different calls without a crash, asserting 2 independent entries; opens a second tester bottle of the same item without a crash, asserting 2 independent entries and correct stock relief. |

### 13.5 Tool run results (this follow-up)

```
$ npx tsc --noEmit                                            → 0 errors
$ npx eslint <every file touched this session>                → 0 problems
$ npx vitest run                                               → 428 files, 5980 tests, all pass
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts
    (every integration test file in the repo, all 134 files)    → 134 files, 1537 tests pass, 1 pre-existing skip
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts \
    integration/accessories.integration.test.ts \
    integration/trade-goods.integration.test.ts \
    integration/cosmetics-sale-idempotency.integration.test.ts \
    integration/promotions.integration.test.ts \
    integration/industry-reports.integration.test.ts \
    integration/consignment.integration.test.ts \
    integration/merchandising.integration.test.ts \
    integration/retail-invoice.integration.test.ts \
    integration/retail-invoice-list.integration.test.ts \
    integration/jewelry-flagship.integration.test.ts \
    integration/gold-sales.integration.test.ts                  → 11 files, 71 tests pass
```

**Net diff this follow-up:** `promotions-service.ts`, `consignment-service.ts`,
`merchandising-service.ts`, `cosmetics-service.ts` (write-off/tester paths;
its sale path was already fixed in §12.2), plus the three test files above.
No changes to gold/watch, no changes to the 15 other already-safe
`emitDomainEvent` call sites, no void/undo UI.

**What §12's flagged risks look like now:** all three are closed. Cosmetics
write-off/tester: fixed. The other emitDomainEvent call sites: all read and
accounted for (3 more bugs fixed, 15 confirmed already safe with a specific
reason each, 1 correct-but-fragile pattern documented). Gold/watch
buyback-relist: verified structurally impossible, not merely untested. The
one item from §12 still open and unstarted is §12.1's proper void/reversal
engine (persisting entry ids per line, teaching the amendment engine to
reverse the industry-specific postings, restoring inventory on void, and
re-adding the void UI only after that lands with its own per-industry test
coverage) — that is a separate, substantially larger body of work, not
attempted in this session.

## 14. The retail void/reversal engine — built, tested, and wired to the UI

§12.1/§13.5 left one open item: retail invoices had no working void. Voiding
one through the café's `amendClosedOrder()` flipped `orders.status` to
`'voided'` while every ledger entry and inventory consumption the invoice's
lines actually posted sat there untouched — the invoice *looked* voided; the
books and the shelf never learned about it. That is why the earlier session
built a void UI, found it broken by inspection, and reverted it rather than
ship it (§12.1). This section is that gap actually closed.

### 14.1 Decision: gold/watch cannot be voided automatically, by design

Asked the product owner how gold/watch should behave. Decision: **block void
entirely** for any invoice containing a gold or watch line, with a specific
Persian refusal, rather than relax the terminal `'sold'` state
`validateWeightItemStatusTransition`/`validateSerialStatusTransition`
(items.ts) enforce. Accessories, cosmetics (non-batch) and trade-goods
(wholesale/tools & fittings/haberdashery) get full automatic void. A future
gold/watch return/reinstatement workflow (manager approval, physical
inspection, explicit disposition) is out of scope — this session does not
touch the sold-state machine at all.

### 14.2 What's voidable, what's refused, and why

New file: `src/lib/retail-invoice-void-service.ts`, exporting
`voidRetailInvoice()` and `RetailInvoiceVoidError`. This is a **separate**
function, not a branch inside `amendClosedOrder()` — that engine is F&B's
own well-tested reverse-then-replay machinery (recipe consumption, menu
modifiers, online-platform commission) and threading retail-only branches
into it risks the very thing this audit protects. What is reused, because it
is genuinely generic: `postExactMirrorEntry`, the `order_amendments` table,
and a newly-exported `snapshotOrder()` (`order-amendment-service.ts` — the
only change to that file, an `export` keyword and a doc comment; F&B's
`amendClosedOrder()` itself is untouched).

| Case | Result |
|---|---|
| Accessories / non-batch cosmetics / trade-goods lines | **Voided automatically**: revenue+COGS(+VAT) mirrored, `item_stock.quantity` restored, commission reversed, loyalty points reversed, payments/receivable reversed |
| Gold or watch line anywhere on the invoice | **Refused**, exact message: `این فاکتور شامل کالای طلا/سریال‌دار است و به دلیل وضعیت نهایی فروش، ابطال خودکار امکان‌پذیر نیست.` |
| Batch-tracked cosmetic line | **Refused** — the FEFO batch allocation a sale consumed is not persisted anywhere recoverable; restoring `item_stock` alone without the same `item_batches` rows would violate migration 0078's "item_stock is the SUM of item_batches" invariant |
| A line's catalogue item was later deleted | **Refused** |
| A line sold before this session (`retail_snapshot.ledgerEntryIds` absent) | **Refused** — "not retroactive": there is no reliable way to re-derive which journal entries a pre-fix sale posted |
| Invoice already has a `customer_returns` row, is not `type='retail'`, or is not `status='completed'` | **Refused** |

Every refusal is validated for **every line before any mutation happens** —
a blocked void never leaves an invoice half-reversed.

### 14.3 The prerequisite: capturing each line's own ledger entry ids

A retail invoice's lines never post under `source_type='order'`; each
industry's own sell service posts its own `source_type`
(`gold_sale`/`watch_sale`/`accessory_sale`/`cosmetic_sale`/`{trade}_sale`),
keyed by a fresh `postingSourceId` (§12/§13's own fix). There was no reliable
way to find "the journal entries this specific line posted" after the fact.
Fix: `RetailInvoiceLineSnapshotBase` (`retail-invoice/types.ts`) gained
`ledgerEntryIds?: string[]`, and `settleLine()`
(`retail-invoice-service.ts`) now records each sell-service's
`revenueEntryId`/`cogsEntryId` into every line kind's stored snapshot at sale
time. This is why a pre-existing invoice cannot be voided automatically —
the field did not exist when it was sold.

### 14.4 A real bug the integration tests caught before shipping

First draft of the stock-restore line read `order_items.quantity` and added
that back to `item_stock`. That is wrong: `retail-invoice-service.ts`'s own
`INSERT INTO order_items` comment says so directly — `unit_price`/`quantity`
on that row are frozen at the F&B-shaped `(line-net, 1)` for every retail
line; the real sold quantity only ever lives in `retail_snapshot.quantity`.
The bug always restored exactly `+1` unit regardless of how many were sold
(e.g. selling 20 units of a wholesale item and voiding it left stock at 81,
not 100). Three of the fourteen new integration tests failed on first run
with this exact off-by-(quantity-1) signature, which is what caught it;
fixed by reading `snapshot.quantity` instead. A second real bug the same
first test run caught: the void's own `order_items` status update to
`'voided'` was rejected by migration 0075's
`guard_order_item_financial_mutation` trigger (`order_not_open`) because
nothing set `app.order_amendment = 'on'` first — the same escape hatch
`amendClosedOrder()`'s own void takes. Both are fixed in the shipped file;
neither would have been caught by type-checking or a hand-read alone.

### 14.5 API route and UI

- `POST /api/sales/invoices/[id]/void` (new) — same permission gate as the
  café's own `ordersAmendClosed`, same `{error, message}` response shape
  `POST /api/sales/invoices` already uses for `RetailInvoiceError`, and the
  same `fiscal_period_locked`/`fiscal_period_soft_closed` mapping the
  amendment route has (a void's reversal lands on the *original* sale's own
  date, so a month closed since then refuses it there too).
- `RetailInvoiceDetailModal` — a «ابطال فاکتور» button next to «چاپ مجدد»,
  shown only when the caller can amend closed orders and the invoice is
  still `completed`. Confirms the reason via `window.prompt`, the same
  pattern the café's own `OrderDetailModal.voidOrder()` already uses (no new
  dialog component invented). A refusal shows the server's own Persian
  message; a success refetches the invoice (so the badge/reason update in
  place) and calls `onVoided()` so the invoice list behind it refreshes.
- Permission threaded from `accounting/pos/page.tsx` (`ordersAmendClosed`) →
  `RetailInvoiceScreen` → `InvoiceManagementView` → the modal — the same
  server-computed-prop pattern `orders/page.tsx` → `OrdersList` →
  `OrderDetailModal` already uses for the café's own `canAmendClosed`.

### 14.6 Tests

New file `integration/retail-invoice-void.integration.test.ts`, 14 tests:
accessories (single line reversed + stock restored + payment cancelled +
`order_amendments` audit row; two-line invoice voided without a
`uq_journal_business_source_posting` collision, proving every reversal gets
its own fresh id; a credit sale's A/R side nets back to zero; the line's
commission accrual reverses; the loyalty points the sale earned reverse;
a second void is refused; a deleted-item line is refused and mutates
nothing; a pre-fix legacy line with no `ledgerEntryIds` is refused and
mutates nothing; an invoice with a `customer_returns` row is refused),
wholesale (trade-goods "stocked" line reversed), cosmetics (non-batch line
voided; batch-tracked line refused), and gold/watch (each refused with the
exact message, leaving the sold unit's terminal status untouched). Also
added a component-level test suite to
`retail-invoice-detail-modal.test.tsx` (5 tests): no void button without the
permission; no void button on an already-voided invoice; cancelling the
reason prompt does nothing; a server refusal shows its Persian message and
never flips the badge; a success refetches and calls `onVoided`.

### 14.7 Tool run results

```
$ npx tsc --noEmit                                             → 0 errors
$ npx eslint <every file touched this section>                 → 0 problems
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts
    integration/retail-invoice-void.integration.test.ts          → 14/14 pass
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts
    (every integration test file in the repo, 135 files)         → 1551 tests pass, 1 pre-existing skip
$ npx vitest run (full unit/component suite, 428 files)         → 5986 tests pass
```

**Net diff this section:** new `src/lib/retail-invoice-void-service.ts`; new
`src/app/api/sales/invoices/[id]/void/route.ts`; `retail-invoice/types.ts`
(+`ledgerEntryIds`); `retail-invoice-service.ts` (`settleLine()` populates
it); `order-amendment-service.ts` (`snapshotOrder` exported, otherwise
untouched); `retail-invoice-detail-modal.tsx` (+void button/flow),
`invoice-management-view.tsx` and `retail-invoice-screen.tsx` (+prop
threading), `accounting/pos/page.tsx` (+permission); new
`integration/retail-invoice-void.integration.test.ts`; new tests appended to
`retail-invoice-detail-modal.test.tsx`. §9's "void/reversal flow audit" and
§12.1's "not attempted this session" note are both superseded by this
section — the engine now exists, is tested, and is reachable from the UI.

## 15. Follow-up session — retail split-payment support

The 91-point brief and §9 both flagged retail as single-tender-only: a
retail invoice could take exactly one settlement (`paymentMethod`), unlike
the café POS's own multi-way split (`PaymentWays`, migration 0091). Chosen
as one of the two highest-value remaining items (the other is §16) rather
than the broader module reorganisation/PIN/redesign items §9 lists as
deferred.

### 15.1 Why retail can't just reuse the café's one-entry split

The café settles ONE order total across several ways with ONE journal
entry. A retail invoice has no single total to settle: it is N
independently-priced lines, each posted by its own industry service
(gold/watch/accessory/cosmetic/trade-goods) through its own revenue entry,
and each of those entries must balance **on its own**. A retail split can't
reuse the café's one-entry shape; the design instead threads the invoice's
tenders through as a shared, mutable **queue** that every line draws its own
total off of, in order. This is genuinely new machinery, not a copy of the
café's — see the header comment in the new `src/lib/retail-tenders.ts`.

### 15.2 What was built

- **`src/lib/retail-tenders.ts`** (new) — `RetailTenderInput` (`{method,
  amount?}`, amount omitted means "take whatever the invoice comes to");
  `buildTenderQueue()` validates the cashier's list (1–`MAX_RETAIL_TENDERS`
  (10) slices, at most one open/amount-less slice, every bounded amount
  positive) and turns it into the running queue; `drawTenders()` is what
  `settleLine()` calls per line, pulling off the front of the queue across as
  many tenders as it takes and mutating the queue so the next line continues
  where this one left off; `resolveTenderAmounts()` is what `payments`
  actually stores — the open tender (if any) resolved to the exact
  remainder, everything else exactly as the cashier typed it, independent of
  how a line's own draw happened to fragment things; `groupTendersByCode()`
  merges two ways that resolve to the same GL account (e.g. two different
  card networks both hitting Bank-Clearing) into one debit line instead of a
  duplicate.
- **`POST /api/sales/invoices` contract** — the body's old singular
  `paymentMethod`/`paymentMethodId`/`paymentReference` fields are replaced by
  `tenders: RawTenderBody[]` (`{method, amount?, paymentMethodId?,
  reference?}`), validated per-slice (unrecognised method, non-integer/
  non-positive amount, reference over 120 chars, more than one open tender →
  `too_many_open_tenders`, more than `MAX_RETAIL_TENDERS` slices, a named
  way's settlement class disagreeing with its slice's method, a
  reference-required way with no reference) before any slice reaches
  `createRetailInvoice`. Bundled into the same change: the route's
  permission gate moved from `PERMISSIONS.ordersCreate` to
  `PERMISSIONS.paymentsTake` — issuing a retail invoice settles it
  immediately (it *is* the till taking payment), and `ordersCreate` alone let
  a role reach this endpoint without the till-taking permission the
  `/accounting/pos` page itself already requires to render the screen that
  calls it.
- **`retail-invoice-screen.tsx` UI** — a toggle next to «روش پرداخت» switches
  between the original single-way radiogroup (unchanged) and a stacked list
  of tender rows (way select, amount input placeholder "باقی‌مانده", optional
  reference field when the way requires one, remove button disabled below 2
  rows, "افزودن روش پرداخت" capped at `MAX_RETAIL_TENDERS`). A non-split
  submit still posts a one-element `tenders` array with no `amount` (open
  tender, unchanged wire shape). Client-side validation blocks submission for
  <2 rows, >1 blank row, an unresolved way, a missing required reference, a
  non-positive typed amount, or a credit-settling row with no customer
  selected — but the running "باقی‌مانده تقریبی/مازاد تقریبی" remaining/
  mismatch display is advisory only and never blocks submission; the server
  (§15's `buildTenderQueue`/`assertTendersExhausted`) is the sole source of
  truth for whether the split actually balances, consistent with every other
  money-math check in this codebase living server-side.

### 15.3 Tests

- `src/lib/retail-tenders.test.ts` — 23 unit tests on the queue engine
  itself (validation, draw-across-multiple-tenders, open-tender-resolves-
  last, overshoot/undershoot detection, GL-account grouping).
- `src/app/api/sales/invoices/route.test.ts` — 10 tests on the new `tenders`
  contract (empty, too many, unrecognised method, non-integer amount, a
  second open tender refused, reference length, settlement-class mismatch,
  reference-required-but-missing, and the happy path: one bounded + one open
  tender reach `createRetailInvoice` in order).
- `integration/retail-split-payment.integration.test.ts` — 8 tests against
  real Postgres: accessories split records one `payments` row per tender and
  splits the line's own debit side across the funding accounts; a partial
  credit tender posts to Accounts Receivable for exactly its own slice and
  requires a customer; an overshot split is refused and commits nothing; an
  undershot split is refused and commits nothing; voiding a split invoice
  reverses every tender, netted by method, regardless of how many `payments`
  rows exist; gold and watch (both multi-entry revenue postings) split their
  payment debit side across cash/bank while the metal/making-charge/VAT (or
  watch equivalent) credit sides stay whole and unaffected by the split.
- `src/app/dashboard/pos/retail-invoice-screen.test.tsx` — 5 component tests
  covering the existing submit-gating behaviour, unaffected by the split
  addition (re-verified, not newly written for split-payment itself; the
  split UI's own interaction paths are covered by the integration tests
  above plus manual code-level validation-path tracing, not a dedicated
  jsdom suite — see §9 for what "manual browser scenarios" still means here).

### 15.4 Tool run results

```
$ npx tsc --noEmit                                              → 0 errors
$ npx eslint <every file touched this section>                  → 0 problems
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts
    integration/retail-split-payment.integration.test.ts          → 8/8 pass
$ npx vitest run src/lib/retail-tenders.test.ts
    src/app/api/sales/invoices/route.test.ts
    src/app/dashboard/pos/retail-invoice-screen.test.tsx           → 38/38 pass
```

(Both suites were re-run again this session as part of the full-repo
verification in §16.4, alongside everything else — still green.)

**Net diff this section:** new `src/lib/retail-tenders.ts` and
`src/lib/retail-tenders.test.ts`; `src/app/api/sales/invoices/route.ts`
(tenders contract + permission gate) and new `route.test.ts`;
`retail-invoice-service.ts` (`settleLine()` threads the queue instead of a
single `paymentMethod`); `retail-invoice-screen.tsx` (split UI) and new
`retail-invoice-screen.test.tsx`; the industry posting-rules files
(`gold-posting-rules.ts`, `watch-posting-rules.ts`,
`accessories-posting-rules.ts`, `cosmetics-posting-rules.ts`,
`trade-goods-posting-rules.ts`) now group a line's resolved tenders by GL
account via `groupTendersByCode()` instead of assuming one settlement per
line; new `integration/retail-split-payment.integration.test.ts`.

## 16. Follow-up session — invoice-management: a payment-display/filter bug, and the full filtered-set export

The second of the two highest-value items chosen for this bucket (§15 is the
first). Two things: a display/filter bug §15 exposed once split-payment
invoices could exist, and the missing full-export §9 had flagged.

### 16.1 The bug: a split-payment invoice's list row and method filter only ever saw its first-posted tender

`src/lib/retail-invoice/list-service.ts`'s query joined `payments` with
`LEFT JOIN LATERAL (... ORDER BY received_at, id LIMIT 1)` — by construction
it could only ever surface **one** payment row per invoice. Once §15 made a
split-payment invoice possible, this had two live consequences: (a) «مدیریت
فاکتورها»'s row showed only whichever tender happened to post first (e.g. a
cash+card split showing only "نقدی", silently hiding the card portion from
the badge and the CSV column); (b) the method filter's `WHERE` clause
compared against that same single joined row, so filtering by "کارت" on a
cash+card split invoice returned nothing — the invoice was invisible to a
search for a method it was genuinely, partially paid with.

Fix: the `LATERAL LIMIT 1` join is replaced by a `payment_summary` CTE that
`jsonb_agg`s every **distinct** `{method, name}` pair per order (filtered to
`p.amount > 0`, so a void's negative reversal row never contributes a
phantom method — see §16.2), and the row's singular `paymentMethod`/
`paymentMethodName` fields are replaced by `paymentMethods:
{method, name}[]`. The method filter (`$4`) changed from matching only the
first-joined row to `EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id =
o.id AND p2.amount > 0 AND p2.method::text = $4)` — it now matches a
split-payment invoice on **any** of its tendered methods. `list-service.ts`
was the sole producer of this shape and `invoice-management-view.tsx`
(the row type, the payment badge, and the CSV column) was its sole consumer
— both updated together; `GET /api/sales/invoices` itself passes the row
through unchanged (it does not re-shape `paymentMethod(s)`), so it needed no
change beyond what §16.3 adds. The public API still speaks `"bank"`, not the
underlying `"card"` payments enum value, for this field — same vocabulary
the singular field used to keep (see the route's own `dbMethod` comment).

### 16.2 Confirming a void's reversal row doesn't contaminate the display

Because the fix's CTE only aggregates `payments` rows with `amount > 0`, a
voided invoice's negative-amount reversal row (§14's void engine) is
excluded from `paymentMethods` — the invoice keeps showing the one way the
customer *originally* tendered with, not the net-zero position after the
reversal. Proven directly: `integration/retail-invoice-list.integration.test.ts`
inserts a negative reversal payment row on a voided invoice and asserts
`paymentMethods` still has exactly one entry, the original method.

### 16.3 Full filtered-set export

§9/§11 had flagged that «خروجی این صفحه» only ever exported the current
page's up-to-20 rows client-side, with no way to export everything a filter
matched. `GET /api/sales/invoices` gained a `format=csv` mode (query param,
same route, same filters, same permission gate — no new endpoint) and an
`all=true` flag that ignores `page`/`pageSize` and re-runs the identical
query with `pageSize = EXPORT_ROW_CAP` (5,000 — a hard cap so a very wide
filter can't exhaust memory or hang the request; the on-screen count badge
tells the cashier how many rows a click will actually fetch). The CSV itself
is built with `rowsToCsv()`/`ReportTable` from `@/lib/report-export` — the
same formula-injection-guarded writer every other export surface in the app
already uses (`reports/export`), not a second implementation. This
incidentally **fixed a latent gap**, not just added a feature: the previous
client-side `downloadCsv()` in `invoice-management-view.tsx` built its CSV
by hand with no formula-injection guard at all (a customer name starting
`=`, `+`, `-`, or `@` would have been executed by Excel on open); both the
existing page-scoped export button and the new full-export button now route
through the same server endpoint and the same guarded writer, so the
duplicate/unguarded writer is gone entirely rather than left alongside a
second, safer one.

UI: the existing «خروجی این صفحه» button now fetches
`GET /api/sales/invoices?format=csv&...same filters...&page&pageSize` instead
of building a `Blob` from `rows` in memory; a new «خروجی کامل (N فاکتور)»
button fetches the same route with `all=true`, using the exact filter-params
builder (`filterParams()`, extracted to a pure module-level function so both
the list-fetch effect and both export actions can never drift from what the
screen is actually filtered to, and so it isn't a React-hooks lint false
positive as a hook dependency).

### 16.4 Tests

- `integration/retail-invoice-list.integration.test.ts` — 2 new tests
  (5 total in the file): a cash+bank split invoice shows both methods in
  `paymentMethods` (sorted, both filters — `cash` and the raw `card` DB
  value the service layer speaks — return it, and a cash-only invoice does
  not show under the split invoice's other method); and the void-reversal
  isolation test in §16.2.
- `src/app/dashboard/pos/invoice-management-view.test.tsx` — 4 new tests
  (9 total in the file): a split-payment row's badge joins every tendered
  method's name; a credit-among-several-methods row still renders (tone
  logic checks `.some(method === "credit")` across the array, not a single
  field); «خروجی این صفحه» requests `format=csv` with the current
  page/pageSize and no `all` param; «خروجی کامل» requests `format=csv&all=
  true` carrying the same filter the screen is showing (proven by setting a
  status filter first and asserting it round-trips into the export request).
- Existing `integration/retail-invoice-list.integration.test.ts` status/
  date-range/pagination tests (3) and existing filter component tests (5)
  re-verified unaffected.

### 16.5 An environment note for this session, not a code defect

`node_modules` and the sandbox's Postgres server do not persist across
working sessions on this branch (only files under the repo root persist).
This session began with `npx tsc` silently trying to fetch a bogus package
and no Postgres listening on 5432; both were one-time setup steps this
session (`npm install`; an embedded PostgreSQL 16 process using the
`embedded-postgres` package already vendored for the desktop-app build,
`user=pos password=pos db=pos` — the same credentials `docker-compose.yml`
and `.env.example` already document — then `scripts/migrate.ts` against it),
not something to fix in the codebase. Noted here so a future session isn't
surprised by the same symptoms.

### 16.6 Tool run results (this session, full repo)

```
$ npx tsc --noEmit                                              → 0 errors
$ npx eslint <every file touched this section>                  → 0 problems
$ DATABASE_URL=... npx vitest run --config vitest.db.config.ts
    (every integration test file, 136 files)                     → 1560 pass, 1 pre-existing skip
$ npx vitest run (full unit/component suite, 430 files)          → 6023 tests pass
$ NODE_OPTIONS="--max-old-space-size=3000" npm run build         → succeeds, full route manifest, 0 errors
```

**Net diff this section:** `src/lib/retail-invoice/list-service.ts`
(`payment_summary` CTE, `EXISTS`-based method filter, `paymentMethods[]`
replacing the singular fields); `src/app/dashboard/pos/invoice-management-view.tsx`
(row type, badge rendering, `filterParams()` extraction, both export
buttons routed through the server); `src/app/api/sales/invoices/route.ts`
(`format=csv`/`all=true` GET mode); 2 new tests in
`integration/retail-invoice-list.integration.test.ts`; 4 new tests in
`invoice-management-view.test.tsx`. §9's "export of all-filtered/selected
rows" gap and this display/filter bug are both closed by this section.

## 17. Remaining backlog against the original 91-point brief

Everything in §9 not superseded by §14 (void/reversal), §15 (split payment),
§16 (invoice-management export/filter fix), or §18 (RTL/accessibility audit)
remains open and was explicitly **not** attempted this bucket, per direction:
the `retail-pos/` module reorganisation, the full desktop/mobile UI redesign,
modal line editors for in-place cart-line edits, a dedicated payment modal,
permission-ID normalisation to `sales.invoice.*`, the supervisor-PIN override
system, a responsive-breakpoint sweep, and the ten manual/browser test
scenarios the original brief lists. A gold/watch return/reinstatement
workflow (manager approval, physical inspection, explicit disposition
outcomes) — distinct from void, which §14 blocks entirely for gold/watch by
design — is also not built. None of these are silent regressions; they are
listed here, as in §9, so they are not mistaken for done.

Permission-ID normalisation and the supervisor-PIN system were considered as
the next item after §16 and deliberately **not** started: the former is not
a pure rename — retail invoices are `orders` rows, so a new `sales.invoice.*`
namespace would need a data migration backfilling every existing business's
custom-role grants (`orders.view` → also `sales.invoice.view`, etc.) or
existing users lose access to retail invoices the moment it ships, which is
a product/rollout decision, not a refactor. The latter needs its own design
decisions (who can set/reset a PIN, lockout behaviour, audit logging) that
were not made. Both are left as backlog rather than guessed at.

## 18. Follow-up session — retail-invoice RTL/accessibility audit

A scoped audit of the three retail-invoice-specific screens
(`retail-invoice-screen.tsx`, `invoice-management-view.tsx`,
`retail-invoice-detail-modal.tsx`) — not a systematic sweep of the whole
product, which §9/§17 still list as open.

### 18.1 What was checked, and came back clean

- **RTL layout** — `grep` for physical-direction Tailwind utilities
  (`left-`/`right-`/`ml-`/`mr-`/`pl-`/`pr-`/`text-left`/`text-right`/
  `rounded-l-`/`rounded-r-`/`border-l-`/`border-r-`) across all three files
  returned nothing; they already use only logical properties (`ps-`/`pe-`/
  `ms-`/`me-`/`start-`/`end-`), consistent with the README's stated
  convention. No directional chevron/arrow icons that would need mirroring
  either.
- **Document direction/language** — set once, correctly, at the root
  (`<html lang="fa" dir="rtl">` in `src/app/layout.tsx`); no per-component
  overrides needed or found.
- **Labelling** — every icon paired with visible text carries
  `aria-hidden="true"` (decorative, not a redundant second announcement); the
  search input and each split-payment tender row's way/amount/reference
  fields have real `aria-label`s (`Field`'s own doc comment already explains
  *why* it offers an `as="div"` mode instead of a wrapping `<label>` for
  multi-control groups — a `<label>` forwards a click on its own whitespace
  to the first labelable descendant, which would silently mis-click a
  radiogroup or chip picker); filter chip groups use `role="group"` +
  `aria-label` with `aria-pressed` toggle buttons, a pattern that needs no
  roving tabindex (unlike a true radiogroup — see §18.2).
- **Modal semantics** — `RetailInvoiceDetailModal` and its tabs are built on
  the shared `Dialog`/`Tabs` primitives (`@/components/ui/dialog`,
  `@/components/ui/tabs`), which already own focus trapping, `aria-modal`,
  Escape-to-close and focus restoration; nothing retail-specific to fix
  there.

### 18.2 The one real finding: the payment-way radiogroup had no keyboard support

`retail-invoice-screen.tsx`'s single-way payment picker uses
`role="radiogroup"`/`role="radio"` — a promise, per WAI-ARIA authoring
practices, that arrow keys move the selection and exactly one radio is a Tab
stop. It kept neither promise: every way was independently tabbable (Tab
had to be pressed once per way instead of once for the whole group) and the
arrow keys did nothing. Two other radiogroups already in this codebase
(`business-settings.tsx`'s «تومان/ریال» choice, `branches-manager.tsx`'s
branch-colour picker) get this right via a small, already-existing,
already-unit-tested shared helper, `src/lib/radio-keys.ts` — this screen's
picker had simply never been wired up to it. Fixed the same way those two
already do: a `buttonsRef` array, `tabIndex={active ? 0 : -1}` (roving
focus), and an `onKeyDown` that resolves the key via `radioMoveForKey(key,
/* rtl */ true)` + `radioTargetIndex()`, moves the selection, and moves DOM
focus to match — so Down/Right-in-RTL advances, Up/Left-in-RTL goes back,
Home/End jump to the ends, and the ring wraps both ways, identical to how a
native `<input type="radio">` group already behaves for a sighted mouse
user.

### 18.3 Tests

`retail-invoice-screen.test.tsx` gained one test: renders the screen with
two payment ways, confirms the first is checked and the only `tabIndex={0}`
element, presses `ArrowDown` and confirms both the checked state *and*
`document.activeElement` moved to the second way (not just one or the
other — a common half-fix), then `ArrowUp` and confirms it wraps back.

### 18.4 Tool run results

```
$ npx tsc --noEmit                                              → 0 errors
$ npx eslint src/app/dashboard/pos/retail-invoice-screen.tsx
    src/app/dashboard/pos/retail-invoice-screen.test.tsx           → 0 problems
$ npx vitest run src/app/dashboard/pos/retail-invoice-screen.test.tsx → 6/6 pass
```

**Net diff this section:** `retail-invoice-screen.tsx` (roving tabindex +
`onKeyDown` on the payment-way radiogroup, using the existing
`src/lib/radio-keys.ts` — no new shared code needed); one new test in
`retail-invoice-screen.test.tsx`. §9/§17's RTL/accessibility item is
narrowed by this section, not closed — see §18's own opening line and §17's
note above for what is still open.
