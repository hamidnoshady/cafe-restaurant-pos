-- ============================================================================
-- 0142_retail_warehouse_documents.sql — Phase 42b (Retail warehouse module:
-- رسید/حواله انبار on the RETAIL stock model)
--
--   * retail_warehouse_documents: a posted in-or-out document of one retail
--     warehouse (a branch), on the items/item_stock/item_batches model the
--     retail trades use — deliberately NOT the F&B tables Phase 42 built
--     (warehouse_documents sits on inventory_items/stock_movements; the two
--     stock worlds stay separate, Phase 21's decision).
--
--     `kind = 'receipt'` (رسید انبار) puts stock in without a purchase;
--     `kind = 'issue'` (حواله انبار) puts stock out without a sale or a
--     supplier return. Both are source documents like item_purchases and
--     item_supplier_returns — created already posted (batch/stock move +
--     ledger entry in the same transaction) and immutable afterwards; a
--     mistake is corrected by issuing the opposite document.
--
--     Posting (retail-warehouse-document-service + retail-stock-posting-rules):
--       receipt: Debit <industry>Inventory (1350 for cosmetics) /
--                Credit 4900 (other income) — stock received without an
--                invoice is other income.
--       issue:   Debit 5900 (other expense) / Credit <industry>Inventory —
--                stock issued without a sale is an other expense, valued at
--                the relieved lot's own cost.
--
--   * retail_warehouse_document_lines: one row per item, carrying the lot
--     number/expiry the line named plus the batch it landed on (receipt) or
--     relieved (issue), so a document stays readable even after the batch
--     rows it touched have been emptied or re-averaged. UNIQUE (document,
--     item) mirrors 0141: one line per item per document.
--
--   * A receipt refuses a supplier on purpose: a receipt WITH a supplier is
--     what «خرید» (item_purchases) already is, and a return TO a supplier is
--     what «حواله بازگشت» (item_supplier_returns) already is. The warehouse
--     document is the supplier-less in/out — hence no supplier column at all.
--
-- Tenancy: both tables are tenant-scoped and get their RLS policy in this
-- same migration, per the repo convention (src/lib/db.ts). The document
-- number is unique per tenant when present (the same name may not be used
-- twice, but unnamed documents may coexist).
-- ============================================================================

CREATE TABLE retail_warehouse_documents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    kind             text NOT NULL CHECK (kind IN ('receipt', 'issue')),
    -- Issue only: free-text destination/recipient (optional).
    recipient        text,
    -- The external reference the document is based on (حواله کاغذی، شماره فاکتور، …).
    document_number  text,
    note             text,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- Receipt: sum of the lines' qty × unit cost. Issue: sum of the lot costs
    -- the relief consumed. Authoritative for the ledger entry.
    total_value_rial bigint NOT NULL DEFAULT 0 CHECK (total_value_rial >= 0)
);
-- One document number per tenant (partial: unnamed documents don't collide).
CREATE UNIQUE INDEX uq_retail_warehouse_documents_number
    ON retail_warehouse_documents (business_id, document_number)
    WHERE document_number IS NOT NULL;
CREATE INDEX idx_retail_warehouse_documents_business ON retail_warehouse_documents (business_id, created_at DESC);
CREATE INDEX idx_retail_warehouse_documents_location ON retail_warehouse_documents (location_id, created_at DESC);
CREATE INDEX idx_retail_warehouse_documents_kind ON retail_warehouse_documents (business_id, kind, created_at DESC);

CREATE TABLE retail_warehouse_document_lines (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES retail_warehouse_documents(id) ON DELETE CASCADE,
    item_id     uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    -- The batch/lot the line landed on (receipt) or relieved (issue), when the
    -- item is batch-tracked. SET NULL: the document line is a historical
    -- record and outlives the batch row it touched.
    batch_id    uuid REFERENCES item_batches(id) ON DELETE SET NULL,
    -- Lot number as the document named it; the detail view shows
    -- COALESCE(line.lot_number, batch.batch_number).
    lot_number  text,
    -- Expiry the line carried, if any; COALESCE(batch.expiry_date) in the
    -- detail view.
    expiry_date date,
    quantity    numeric(24, 9) NOT NULL CHECK (quantity > 0),
    -- Rial per unit at the document. Receipt: the cost the line stated.
    -- Issue: the relieved lot's own cost.
    unit_cost   bigint NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    value_rial  bigint NOT NULL CHECK (value_rial >= 0),
    note        text,
    UNIQUE (document_id, item_id)
);
CREATE INDEX idx_retail_warehouse_document_lines_document ON retail_warehouse_document_lines (document_id);
CREATE INDEX idx_retail_warehouse_document_lines_item ON retail_warehouse_document_lines (item_id);

-- Row-level security — in the same migration that creates the tables.
-- The header carries business_id directly (Shape 1); the lines are scoped
-- through their document (Shape 2, the item_purchase_items pattern).

ALTER TABLE retail_warehouse_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_warehouse_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retail_warehouse_documents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE retail_warehouse_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_warehouse_document_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retail_warehouse_document_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM retail_warehouse_documents d
         WHERE d.id = retail_warehouse_document_lines.document_id
           AND d.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM retail_warehouse_documents d
         WHERE d.id = retail_warehouse_document_lines.document_id
           AND d.business_id = app_current_business()));
