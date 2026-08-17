-- Phase 27 Wave 8 — purchasing, returns and transfers on the `items` model.
--
-- F&B has a complete purchasing/returns/transfers engine on
-- `inventory_items`/`stock_movements`/`inventory_lots` (purchase-receipt-costing.ts,
-- supplier-return-service.ts, transfer-service.ts). This is the retail half of the
-- same semantics against `items`/`item_stock`/`item_batches`/`item_serials` —
-- mirroring, not merging, the two stock worlds, per Phase 21's recorded decision.
--
-- Each operation writes a *document* (purchase, return, transfer) so the trade has
-- the paper trail its F&B counterpart has, and the stock effect happens through the
-- existing per-item receive paths (receiveStock / receiveBatch / addSerial) so there
-- is still exactly one stock engine. Ledger postings ride the domain-event engine.
--
-- Reorder points live on `item_stock` (one number per sellable variant), and
-- `last_sold_at` is stamped by the sale paths so dead-stock is a query, not a guess.

ALTER TABLE item_stock
    ADD COLUMN reorder_point numeric(24, 9) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
    ADD COLUMN last_sold_at timestamptz;

-- ---------------------------------------------------------------- purchases

CREATE TABLE item_purchases (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
    status      text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'cancelled')),
    total       bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
    note        text,
    received_at timestamptz NOT NULL DEFAULT now(),
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_item_purchases_business ON item_purchases (business_id);
CREATE INDEX idx_item_purchases_location ON item_purchases (location_id);

ALTER TABLE item_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_purchases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_purchases FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE item_purchase_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id uuid NOT NULL REFERENCES item_purchases(id) ON DELETE CASCADE,
    item_id     uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity    numeric(24, 9) NOT NULL CHECK (quantity > 0),
    unit_cost   bigint NOT NULL CHECK (unit_cost >= 0),
    -- Set on receive for a serial-tracked item: the physical unit this line
    -- created, so a later return can name it.
    serial_id   uuid REFERENCES item_serials(id) ON DELETE SET NULL
);

CREATE INDEX idx_item_purchase_items_purchase ON item_purchase_items (purchase_id);
CREATE INDEX idx_item_purchase_items_item ON item_purchase_items (item_id);

ALTER TABLE item_purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_purchase_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_purchase_items FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_purchases p WHERE p.id = item_purchase_items.purchase_id
          AND p.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_purchases p WHERE p.id = item_purchase_items.purchase_id
          AND p.business_id = app_current_business()));

-- ---------------------------------------------------------- supplier returns

CREATE TABLE item_supplier_returns (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    purchase_id       uuid REFERENCES item_purchases(id) ON DELETE RESTRICT,
    settlement_method text NOT NULL CHECK (settlement_method IN ('accounts_payable', 'cash', 'bank', 'supplier_receivable')),
    total_value_rial  bigint NOT NULL DEFAULT 0 CHECK (total_value_rial >= 0),
    reason            text NOT NULL,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key   text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, idempotency_key)
);

CREATE INDEX idx_item_supplier_returns_business ON item_supplier_returns (business_id);

ALTER TABLE item_supplier_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_supplier_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_supplier_returns FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE item_supplier_return_items (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id uuid NOT NULL REFERENCES item_supplier_returns(id) ON DELETE CASCADE,
    item_id   uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    batch_id  uuid REFERENCES item_batches(id) ON DELETE SET NULL,
    serial_id uuid REFERENCES item_serials(id) ON DELETE SET NULL,
    quantity  numeric(24, 9) NOT NULL CHECK (quantity > 0),
    value_rial bigint NOT NULL CHECK (value_rial >= 0)
);

CREATE INDEX idx_item_supplier_return_items_return ON item_supplier_return_items (return_id);

ALTER TABLE item_supplier_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_supplier_return_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_supplier_return_items FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_supplier_returns r WHERE r.id = item_supplier_return_items.return_id
          AND r.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_supplier_returns r WHERE r.id = item_supplier_return_items.return_id
          AND r.business_id = app_current_business()));

-- ---------------------------------------------------------------- transfers

CREATE TABLE item_stock_transfers (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    source_location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    destination_location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    status                 text NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'shipped', 'received', 'cancelled')),
    note                   text,
    created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key        text NOT NULL,
    shipped_at             timestamptz,
    received_at            timestamptz,
    cancelled_at           timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, idempotency_key),
    CHECK (source_location_id <> destination_location_id)
);

CREATE INDEX idx_item_stock_transfers_business ON item_stock_transfers (business_id);

ALTER TABLE item_stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock_transfers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE item_stock_transfer_items (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id            uuid NOT NULL REFERENCES item_stock_transfers(id) ON DELETE CASCADE,
    source_item_id         uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    destination_item_id    uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity               numeric(24, 9) NOT NULL CHECK (quantity > 0),
    -- The cost value shipped, set at ship time so receive can post the same
    -- number without re-deriving it after the source has already decremented.
    value_rial             bigint CHECK (value_rial IS NULL OR value_rial >= 0)
);

CREATE INDEX idx_item_stock_transfer_items_transfer ON item_stock_transfer_items (transfer_id);

ALTER TABLE item_stock_transfer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_transfer_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock_transfer_items FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_transfers t WHERE t.id = item_stock_transfer_items.transfer_id
          AND t.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_transfers t WHERE t.id = item_stock_transfer_items.transfer_id
          AND t.business_id = app_current_business()));
