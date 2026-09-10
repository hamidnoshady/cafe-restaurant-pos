-- ============================================================================
-- 0141_warehouse_documents.sql — Phase 42 (Warehouse module: رسید/حواله انبار)
--
--   * warehouse_documents: a posted in-or-out document of one warehouse.
--     `kind = 'receipt'` (رسید انبار) puts stock in without a purchase order;
--     `kind = 'issue'` (حواله انبار) puts stock out without a sale or waste
--     entry. Both are source documents like purchases, waste and counts —
--     they are created already posted (stock movement + ledger entry in the
--     same transaction) and are immutable afterwards; a mistake is corrected
--     by issuing the opposite document.
--
--     Posting:
--       receipt: Debit 1300 (inventory asset) / Credit 4900 (other income)
--                — stock received without an invoice is other income.
--       issue:   Debit 5900 (other expense) / Credit 1300 (inventory asset)
--                — stock issued without a sale is an other expense, valued
--                at the cost the exact-costing path consumed.
--     Both accounts exist in every industry's COA template (coa-template.ts).
--
--   * stock_movement_type gains 'warehouse_in' / 'warehouse_out' so the stock
--     ledger separates these documents from purchases, sales, waste and count
--     adjustments (the same shape 0017 used for transfer_in/transfer_out).
--
--   * inventory_event_type gains 'warehouse_receipt' / 'warehouse_issue' so
--     the event trail names the document.
--
--   * inventory_negative_layer_settlements gains a fourth source: a receipt
--     can close open shortages of an item exactly as a purchase receipt, a
--     count surplus or a production output does (0019/0090 generalised the
--     same table for those).
--
-- Tenancy: both new tables are tenant-scoped and get their RLS policy in this
-- same migration, per the repo convention (src/lib/db.ts).
-- ============================================================================

ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'warehouse_in';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'warehouse_out';
ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'warehouse_receipt';
ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'warehouse_issue';

CREATE TABLE warehouse_documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    kind            text NOT NULL CHECK (kind IN ('receipt', 'issue')),
    -- Receipt only: the branch supplier the stock came from (optional).
    supplier_id     uuid REFERENCES suppliers(id) ON DELETE SET NULL,
    -- Issue only: free-text destination/recipient (optional).
    recipient       text,
    -- The external reference the document is based on (supplier invoice no., …).
    document_number text,
    note            text,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Receipt: sum of the lines' qty × unit cost. Issue: sum of the cost the
    -- exact-costing path consumed. Authoritative for the ledger entry.
    total_value_rial bigint NOT NULL DEFAULT 0 CHECK (total_value_rial >= 0)
);
CREATE INDEX idx_warehouse_documents_business ON warehouse_documents (business_id, created_at DESC);
CREATE INDEX idx_warehouse_documents_location ON warehouse_documents (location_id, created_at DESC);
CREATE INDEX idx_warehouse_documents_kind ON warehouse_documents (business_id, kind, created_at DESC);

CREATE TABLE warehouse_document_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       uuid NOT NULL REFERENCES warehouse_documents(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity          numeric(14, 3) NOT NULL CHECK (quantity > 0),
    unit_cost         bigint NOT NULL DEFAULT 0 CHECK (unit_cost >= 0), -- Rial, receipt lines only
    value_rial        bigint NOT NULL CHECK (value_rial >= 0),
    note              text,
    UNIQUE (document_id, inventory_item_id)
);
CREATE INDEX idx_warehouse_document_lines_document ON warehouse_document_lines (document_id);
CREATE INDEX idx_warehouse_document_lines_item ON warehouse_document_lines (inventory_item_id);

-- A settlement row names exactly one source document; a given receipt settles
-- a given negative layer at most once, so a retried transaction cannot
-- double-release the same provisional value (mirrors 0019/0090).
ALTER TABLE inventory_negative_layer_settlements
    ADD COLUMN warehouse_document_id uuid REFERENCES warehouse_documents(id) ON DELETE RESTRICT;

ALTER TABLE inventory_negative_layer_settlements
    DROP CONSTRAINT chk_negative_settlement_source;
ALTER TABLE inventory_negative_layer_settlements
    ADD CONSTRAINT chk_negative_settlement_source
    CHECK (num_nonnulls(purchase_item_id, stock_count_id, production_run_id, warehouse_document_id) = 1);

CREATE UNIQUE INDEX uq_negative_settlement_warehouse_document
    ON inventory_negative_layer_settlements (warehouse_document_id, negative_layer_id)
    WHERE warehouse_document_id IS NOT NULL;

-- Row-level security — in the same migration that creates the tables.
--
-- warehouse_documents carries business_id directly (Shape 1). The lines table
-- is scoped through its document (Shape 2, the stock_count_lines pattern).

ALTER TABLE warehouse_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_documents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE warehouse_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_document_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_document_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM warehouse_documents d
         WHERE d.id = warehouse_document_lines.document_id AND d.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM warehouse_documents d
         WHERE d.id = warehouse_document_lines.document_id AND d.business_id = app_current_business()));
