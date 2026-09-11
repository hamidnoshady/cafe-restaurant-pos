# Phase 42 — the warehouse module: documents, levels and the count, in the warehouse's own terms

The inventory workspace already knew how to move stock (purchases, waste, transfers,
counts, production) but its menu answered the POS's questions — "what is an item, what
does it cost to make" — while the warehouse's questions sat behind those sections. This
phase reorganises the workspace around the warehouse's own menu, and builds the two
functions it was missing: the **warehouse document** (رسید/حواله انبار) and the
**per-warehouse stock level** (موجودی انبار).

Nothing existing is rebuilt: items, recipes, production, suppliers, purchases, waste,
transfers, barcodes and the count keep their sections and their code. The count simply
gets the warehouse's own name for it — «انبارگردانی» — and the new sections sit in
front, grouped as the module lists them:

| Group | Section | What it is |
|---|---|---|
| انبارها | لیست انبارها | The business's locations with what each holds (items, value, low count, last movement) + the افزودن انبار form |
| انبارها | موجودی انبار | One row per active item of a warehouse: quantity from the stock ledger, value from `v_inventory_valuation`, low/out badge |
| انبارها | انبارگردانی | The existing `stock-counts` section, unchanged code, the warehouse's name |
| سند انبار | ثبت رسید انبار/حواله | One screen, two documents: a receipt (in) or an issue (out), posted on create |
| سند انبار | رسید و حواله‌های انبار | The ledger of those documents, filtered by kind and warehouse, with a line-level detail dialog |
| اقلام و عملیات | … | The pre-existing F&B sections, same relative order as before |

## The warehouse document

A **warehouse document** (`warehouse_documents`, migration `0141`) is a posted source
document, created already complete — stock movement and ledger entry in one transaction,
immutable afterwards, corrected by the opposite document. It is the "other in" / "other
out" of classic warehouse keeping: stock that entered without a purchase order, or left
without a sale or waste entry.

- **receipt (رسید)** — line qty × whole-Rial unit cost is authoritative. The receipt
  settles the item's open negative layers first (a physical receipt is evidence the
  shortage is covered — the same mechanics as a purchase receipt's positive portion and
  the 0019/0090 settlement generalisation), and the residual becomes a FIFO lot or a
  weighted-average carrying value. Ledger: **Debit 1300 (inventory) / Credit 4900
  (other income)** — stock received without an invoice is other income.
- **issue (حواله)** — lines are consumed through `consumeInventoryExact` exactly like a
  sale (a priced negative layer opens when the stock runs short), so the posted value is
  the exact-costing cost of what actually left. Ledger: **Debit 5900 (other expense) /
  Credit 1300 (inventory)**.

Both accounts exist in every industry's COA template, so the posting rule
(`inventory.operational_posting`, the same rule waste and counts post through) needs no
per-industry lookup. The movement ledger gains `warehouse_in` / `warehouse_out` so the
documents stay separable from purchases, sales, waste and count adjustments — the same
shape 0017 used for `transfer_in`/`transfer_out`.

## What was built

- **`migrations/0141_warehouse_documents.sql`** — `warehouse_documents` (+ per-branch
  supplier link and free-text recipient) and `warehouse_document_lines` (unique item per
  document), both tenant-scoped with their RLS policy in the same migration; the four new
  enum values; the settlement table's fourth source (`warehouse_document_id`) with its
  exactly-one-source CHECK and its per-document uniqueness index.
- **`src/lib/warehouse-document-service.ts`** — the posting path, lifted the way
  `waste-service.ts` was (one function for route and any future executor). Pure
  parsing/valuation helpers (`parseWarehouseDocumentLines`, `lineValue`, kind→type
  mapping) are unit-tested in `warehouse-document-service.test.ts`; the DB work follows
  `applyPurchaseReceiptCosting`'s exact-decimal discipline (Decimal text, whole-Rial
  bigint, `allocateRialByWeight` across settlement portions).
- **`src/lib/coa-template.ts`** — `otherIncome` (4900) and `otherExpense` (5900) join
  `WELL_KNOWN_CODES`; both codes were already seeded in every industry template.
- **`src/app/api/inventory/warehouses`** — GET: the locations with per-warehouse stock
  statistics (value from `v_inventory_valuation`, low count by the same
  `reorder_level` rule as the low-stock banner, last movement) and each warehouse's
  active suppliers (for the document form). POST: «افزودن انبار» — delegates to
  `branch-service`'s `createBranch`, the one write path for locations.
- **`src/app/api/inventory/warehouse-documents`** — GET lists documents (kind and
  warehouse filters); POST creates and posts one. **`…/[id]`** returns a document with
  its lines. **`src/app/api/inventory/stock-levels`** — the per-warehouse level rows and
  the screen's totals.
- **`src/app/dashboard/inventory/`** — four new sections (`warehouses-section`,
  `document-form-section`, `documents-section`, `stock-section`) built from the
  `page-chrome` primitives, and `inventory-manager` regrouped into the three warehouse
  groups with a rail nav (13 sections no longer fit a pill strip).

## What is deliberately not here

- **Back-dating.** A document posts "now", like waste and counts. Back-dated entries go
  through the closed-order amendment machinery, which this document type does not touch.
- **Deletion.** A posted document is corrected by the opposite document (a receipt
  corrects an issue and vice versa), the same posture as counts, production runs and
  transfers — never an in-place edit or delete.
- **Per-section app availability.** Sections follow the `inventory` module's state;
  nothing new is added to the per-app enable/disable surface.
