-- Phase 1 inventory/accounting integrity. Forward-only: existing postings are
-- retained and deliberately not backfilled because their provenance cannot be
-- inferred safely.
CREATE TYPE inventory_event_type AS ENUM (
  'opening', 'purchase_receipt', 'sale_consumption', 'waste',
  'stock_count_adjustment', 'customer_return', 'supplier_return', 'transfer',
  'nrv_write_down'
);
CREATE TYPE inventory_posting_status AS ENUM ('pending', 'posted', 'failed', 'reversed');

CREATE TABLE inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  event_type inventory_event_type NOT NULL,
  source_type text NOT NULL,
  source_id uuid,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  posting_status inventory_posting_status NOT NULL DEFAULT 'pending',
  reversal_of uuid REFERENCES inventory_events(id) ON DELETE RESTRICT,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (business_id, source_type, source_id, event_type),
  UNIQUE NULLS NOT DISTINCT (business_id, idempotency_key)
);
CREATE INDEX idx_inventory_events_location_effective ON inventory_events(location_id, effective_at);

ALTER TABLE stock_movements ADD COLUMN inventory_event_id uuid REFERENCES inventory_events(id) ON DELETE RESTRICT;
ALTER TABLE inventory_lots ADD COLUMN inventory_event_id uuid REFERENCES inventory_events(id) ON DELETE RESTRICT;
ALTER TABLE journal_entries
  ADD COLUMN inventory_event_id uuid REFERENCES inventory_events(id) ON DELETE RESTRICT,
  ADD COLUMN posting_kind text;
CREATE UNIQUE INDEX uq_journal_business_source_posting
  ON journal_entries(business_id, source_type, source_id, posting_kind)
  WHERE source_id IS NOT NULL AND posting_kind IS NOT NULL;
CREATE UNIQUE INDEX uq_stock_event_item_type
  ON stock_movements(inventory_event_id, inventory_item_id, type)
  WHERE inventory_event_id IS NOT NULL;

ALTER TABLE stock_count_lines
  ADD COLUMN unit_carrying_cost numeric(24,9) NOT NULL DEFAULT 0,
  ADD COLUMN variance_value bigint NOT NULL DEFAULT 0;
ALTER TABLE stock_counts ADD COLUMN inventory_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT;

-- Preserve exact extended invoice value rather than attempting to reconstruct
-- it from a rounded per-base-unit cost.
ALTER TABLE purchase_items ALTER COLUMN unit_cost TYPE numeric(24,9) USING unit_cost::numeric;
ALTER TABLE stock_movements ALTER COLUMN unit_cost TYPE numeric(24,9) USING unit_cost::numeric;
ALTER TABLE inventory_lots ALTER COLUMN unit_cost TYPE numeric(24,9) USING unit_cost::numeric;
ALTER TABLE inventory_items ALTER COLUMN avg_cost TYPE numeric(24,9) USING avg_cost::numeric;
ALTER TABLE purchase_items ADD COLUMN extended_cost bigint;
UPDATE purchase_items SET extended_cost = round(quantity * unit_cost)::bigint WHERE extended_cost IS NULL;
ALTER TABLE purchase_items ALTER COLUMN extended_cost SET NOT NULL;

-- Existing businesses need the count accounts as well as fresh templates.
INSERT INTO accounts(business_id, code, name, type)
SELECT b.id, v.code, v.name, v.type::account_type
FROM businesses b CROSS JOIN (VALUES
 ('5160', 'هزینه کسری و مغایرت شمارش', 'expense'),
 ('4910', 'درآمد اضافه شمارش موجودی', 'revenue')
) AS v(code,name,type)
ON CONFLICT (business_id, code) DO NOTHING;

CREATE OR REPLACE VIEW v_inventory_valuation AS
WITH method AS (
 SELECT l.id location_id, COALESCE(s.value->>'method','fifo') costing_method
 FROM locations l JOIN settings s ON s.business_id=l.business_id AND s.key='inventory.costing'
), stock AS (
 SELECT inventory_item_id, sum(quantity) stock_qty,
        sum(CASE WHEN quantity < 0 THEN -quantity ELSE 0 END) FILTER (WHERE unit_cost=0) unpriced_qty
 FROM stock_movements GROUP BY inventory_item_id
), lots AS (
 SELECT inventory_item_id, sum(remaining_qty) lot_qty,
        round(sum(remaining_qty * unit_cost))::bigint lot_value
 FROM inventory_lots WHERE remaining_qty > 0 GROUP BY inventory_item_id
)
SELECT ii.location_id, l.business_id, ii.id inventory_item_id, ii.name item_name, ii.unit,
       COALESCE(s.stock_qty,0) stock_qty, m.costing_method, ii.avg_cost,
       COALESCE(lo.lot_qty,0) fifo_lot_qty,
       CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.lot_value,0)
            ELSE round(COALESCE(s.stock_qty,0)*ii.avg_cost)::bigint END carrying_value,
       COALESCE(s.unpriced_qty,0) provisional_quantity,
       COALESCE(s.stock_qty,0)-COALESCE(lo.lot_qty,0) quantity_difference,
       0::bigint write_down_value,
       CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.lot_value,0)
            ELSE round(COALESCE(s.stock_qty,0)*ii.avg_cost)::bigint END valuation
FROM inventory_items ii JOIN locations l ON l.id=ii.location_id
JOIN method m ON m.location_id=ii.location_id
LEFT JOIN stock s ON s.inventory_item_id=ii.id
LEFT JOIN lots lo ON lo.inventory_item_id=ii.id
WHERE ii.is_active OR COALESCE(s.stock_qty,0)<>0 OR COALESCE(lo.lot_value,0)<>0;
