# Phase 42b — the retail warehouse module: the same warehouse menu, on the retail stock model

Phase 42 gave F&B (`/accounting/inventory`) the warehouse's own menu — warehouses, documents,
levels, the count. The retail trades' «خرید و انبار» (`/accounting/inventory`) still answered the
purchasing question only: one page with the purchase form, the supplier return and the
low/dead-stock reports, everything at once. This phase rebuilds that screen into the same
warehouse module shape Phase 42 established, **on the retail stock model**
(`items` / `item_stock` / `item_batches`, the model the cosmetics business uses) — not on
F&B's `inventory_items`/`stock_movements`, which stay untouched.

Nothing existing is rebuilt: the three retail features that already lived on the page —
purchase receiving (خرید), supplier return (حواله بازگشت) and the low/dead-stock report
(گزارش) — are **extracted into section components unchanged** and re-homed in the module's
«اقلام و عملیات» group. The count (انبارگردانی) keeps its code and its own tab. What is new
is the warehouse half:

| Group | Section | What it is |
|---|---|---|
| انبارها | افزودن انبار | Creates a location through `createBranch` — the one write path for locations |
| انبارها | لیست انبارها | The business's branches with retail stock statistics (items, value, low count, last stock touch) |
| سند انبار | ثبت رسید انبار/حواله | One screen, two documents: a receipt (in) or an issue (out), posted on create |
| سند انبار | رسید و حواله‌های انبار | The ledger of those documents (kind/warehouse filters, search, line-level detail dialog) |
| اقلام و عملیات | موجودی انبار | One row per active item of a warehouse: quantity, running cost, value, low/out badge, totals footer |
| اقلام و عملیات | انبارگردانی | The existing retail stock-count section, unchanged code |
| اقلام و عملیات | خرید / حواله بازگشت / گزارش | The existing forms, extracted unchanged |

`?tab=` deep-links into any section (the same contract the inventory workspace offers), and
the rail is the `section-nav.tsx` rail variant over the `page-chrome.tsx` primitives — no
hand-rolled chrome.

## The retail warehouse document

A **retail warehouse document** (`retail_warehouse_documents`, migration `0142`) is a posted
source document on the retail model, created already complete — lot/stock move + ledger entry
in one transaction, immutable afterwards, corrected by the opposite document. It is the
"other in / other out" of warehouse keeping for a shop that has no purchase order and no sale
to hang the movement on.

- **receipt (رسید)** — line qty × whole-Rial unit cost is authoritative for the ledger. The
  lot named on the line (optional; generated as `W-<doc>-<n>` when absent) is **upserted**
  into `item_batches`: an existing lot gains the quantity, is re-averaged to the weighted
  average (`nextLotUnitCost`) and keeps its expiry unless the line supplies one (COALESCE); a
  new lot is created through `receiveBatch`. Either way `item_stock` is rolled to the SUM of
  the item's batches at their weighted-average cost — the **0078 invariant**, through the very
  same `rollItemStockToBatches` write `receiveBatch` ends with (extracted from it, zero
  behavior change). A `tracking='none'` item goes through `receiveStock`, the purchase path's
  own engine. Ledger: **Debit `<industry>Inventory` (1350 for cosmetics) / Credit 4900 (other
  income)** — stock received without an invoice is other income.
- **issue (حواله)** — a batch-tracked line must **name an existing lot** of the item at that
  branch; the lot must cover the quantity; the lot is relieved **at the lot's own cost**. A
  `tracking='none'` line is relieved from `item_stock` at its running cost. After relief the
  0078 rollup runs again. **Short stock, a missing lot and over-lot are all refused** — retail
  has no negative layers, so F&B's 0141 negative-layer settlement machinery deliberately does
  not apply and was not copied. Ledger: **Debit 5900 (other expense) / Credit
  `<industry>Inventory`**.

### Ledger semantics

Both accounts exist in every industry's COA template, and the industry inventory account is
resolved live by the posting rule — the same `inventoryCodeForBusiness` every `retail.*` stock
rule uses, exported so the create summary names the account the rule actually posted to:

| Document | Debit | Credit | Amount |
|---|---|---|---|
| receipt | `<industry>Inventory` | 4900 سایر درآمدها | Σ line qty × unit cost |
| issue | 5900 سایر هزینه‌ها | `<industry>Inventory` | Σ line qty × the relieved lot's own cost |

The GL therefore always reconciles with the batch ledger: after any sequence of documents,
`SUM(item_batches.quantity)` = `item_stock.quantity`, the weighted average across batches =
`item_stock.unit_cost`, and the inventory account's net balance equals the total value of
stock still on hand (integration tests 2–4 and the smoke check assert exactly this).

### Refusals (server-side, strict)

- **Serial-tracked items** and **weight-tracked items** — their intake paths are
  one-row-per-unit (`item_serials` / weight attributes), not a fungible quantity on
  `item_stock`.
- **A supplier on any warehouse document** — a receipt *with* a supplier is «خرید»
  (`item_purchases`), a return *to* one is «حواله بازگشت» (`item_supplier_returns`); both
  already exist and keep their own flows. The warehouse document is the supplier-less in/out,
  and the migration carries no supplier column at all.
- **Short stock / missing lot / over-lot** on issues (no negative layers in retail).
- **A duplicate document number per tenant** (partial unique index in the migration, plus a
  clean pre-check), and items of another branch or another tenant's warehouse.

## What was built

- **`migrations/0142_retail_warehouse_documents.sql`** — `retail_warehouse_documents` (kind
  receipt/issue, free-text recipient, per-tenant-unique document number) and
  `retail_warehouse_document_lines` (item, batch link, lot number, expiry, qty, unit cost,
  value; UNIQUE(document, item) mirroring 0141), both tenant-scoped with their RLS policies
  in the same migration.
- **`src/lib/retail-warehouse-document-service.ts`** — the posting path, lifted the way
  `warehouse-document-service.ts` was (one function for the route and any future executor).
  Pure helpers (`parseRetailWarehouseDocumentLines` with the retail module's Number-based
  validators, `retailLineValue`, `nextLotUnitCost`, `preservedExpiry`, `lotCoversQuantity`,
  `generatedLotNumber`) are unit-tested; the DB work reuses `receiveBatch`,
  `rollItemStockToBatches`, `receiveStock` and `getStock` rather than inventing parallel
  writes.
- **`src/lib/cosmetics-service.ts`** — `receiveBatch`'s rollup tail extracted into the
  exported `rollItemStockToBatches` (a pure refactor; the retail warehouse document flow
  relieves and receives lots through the same write, so the 0078 invariant has one
  implementation).
- **`src/lib/retail-stock-posting-rules.ts`** — the two new rules,
  `retail.warehouse_receipt` and `retail.warehouse_issue`, registered with the posting engine
  the same way every `retail.*` rule is.
- **API** (same auth/tenant middleware as the sibling `/api/stock/*` routes):
  `GET/POST /api/stock/warehouses` (list with retail stock statistics / create via
  `createBranch`), `GET /api/stock/stock-levels` (per-item rows, search, low/out flags,
  unit+value totals), `POST/GET /api/stock/warehouse-documents` (create with the posting
  summary — total, entry id, Dr/Cr codes — and list with kind/warehouse/search filters),
  `GET /api/stock/warehouse-documents/[id]` (header + lines, lot via
  `COALESCE(line.lot, batch.lot)`, expiry, cost, totals), `GET /api/stock/batches?item=&branch=`
  (the issue form's lot select).
- **UI** (`src/app/dashboard/stock/`) — `page.tsx` restructured into the server-framed
  `StockManager` rail (three groups, `?tab=` deep links); new `warehouses-section` (add form +
  list), `document-form-section` (receipt/issue with per-line qty, cost, lot + Jalali expiry
  picker on receipts, lot select on issues, «≈» value, GL summary on success),
  `documents-section` (list + detail dialog), `stock-levels-section` (search + low/out chips +
  totals footer); `purchases-section`, `returns-section` and `reports-section` are the existing
  forms extracted unchanged; `stock-count-section` is untouched.

## Test matrix

**Unit** (`src/lib/retail-warehouse-document-service.test.ts`, 23 tests) — kind recognition
and event mapping; every parse refusal (`no_items`, `invalid_line`, `invalid_quantity`,
`missing_cost`, `invalid_cost`); lot/expiry normalisation; `retailLineValue` rounding
(half-up, fractional quantities); `nextLotUnitCost` weighted-average math (including a null
existing cost and rounding); `preservedExpiry` COALESCE semantics; `lotCoversQuantity`;
`generatedLotNumber`.

**Integration** (`integration/retail-warehouse-document.integration.test.ts`, 11 tests —
per-test BEGIN/ROLLBACK, real cosmetics chart of accounts via
`provisioning.seedChartOfAccounts`, items of all four trackings):

| # | Claim |
|---|---|
| 1 | A receipt posts Debit 1350 / Credit 4900 and lands stock on both item kinds |
| 2 | A lot receipt re-averages the lot and rolls `item_stock` to the batch sum (0078) |
| 3 | Repeated lot upserts keep summing quantity and re-averaging cost (one batch row, never a fork) |
| 4 | An issue relieves the named lot at its own cost and posts Debit 5900 / Credit 1350 |
| 5 | Short stock on a plain item is refused (no negative layers) |
| 6 | An issue without a lot, or with a lot that does not exist, is refused |
| 7 | An issue beyond the lot's own quantity is refused (even when the item as a whole could cover it) |
| 8 | Serial-tracked items are refused |
| 9 | Weight-tracked items are refused |
| 10 | A supplier on a receipt is refused — that is what خرید and حواله بازگشت are |
| 11 | Another tenant's warehouse and a foreign branch's item are refused; expiry is created, preserved, then re-dated |

**Smoke** (manual, against a running production server as the unprivileged app role): a demo
cosmetics business receives an item (new lot with expiry, then a top-up at another cost),
issues part of the lot, and the checks confirm (a) `/accounting/inventory` renders all sections
and (b) GL 1350/4900/5900 reconcile exactly with the batch ledger — SUM of batches =
`item_stock` quantity and value, and the inventory account's net balance equals stock on hand.

## What is deliberately not here

- **The F&B warehouse module is untouched** — `/accounting/inventory`, the `inventory` feature
  and everything under `inventory_items`/`stock_movements` were used purely as pattern
  reference, per the Phase 21 decision that the two stock worlds stay separate.
- **Back-dating and deletion** — a document posts "now" and is corrected by the opposite
  document, the same posture as Phase 42's documents, counts and production runs.
- **Per-section app availability** — sections follow the `stock` module's state; nothing new
  is added to the per-app enable/disable surface.
