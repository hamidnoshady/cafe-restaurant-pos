-- Corrective, forward-only fixes for inventory/accounting integrity.
-- PostgreSQL names the second table UNIQUE constraint from 0012
-- inventory_events_business_id_idempotency_key_key (PostgreSQL's generated
-- <table>_<columns>_key name for the 0012 table constraint).
ALTER TABLE inventory_events
  DROP CONSTRAINT IF EXISTS inventory_events_business_id_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_events_business_idempotency_key
  ON inventory_events (business_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Immutable, per-unit ingredient requirements captured when a kitchen item is sent.
CREATE TABLE order_item_inventory_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  required_quantity numeric(24,9) NOT NULL CHECK (required_quantity > 0),
  source_menu_item_id uuid,
  source_modifier_ids uuid[] NOT NULL DEFAULT '{}',
  capture_method text NOT NULL DEFAULT 'kitchen_submit'
    CHECK (capture_method IN ('kitchen_submit','legacy_payment_fallback','manager_correction')),
  audit_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, inventory_item_id)
);
CREATE INDEX idx_order_item_inventory_snapshots_item ON order_item_inventory_snapshots(order_item_id);

CREATE FUNCTION reject_inventory_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order item inventory snapshots are immutable; create an explicit correction';
END $$;
CREATE TRIGGER trg_inventory_snapshot_immutable
  BEFORE UPDATE OR DELETE ON order_item_inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_inventory_snapshot_mutation();

-- Explicit shortages. Receipts settle these oldest-first before creating an
-- available lot. Costs remain numeric until the journal boundary.
CREATE TABLE inventory_negative_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  source_inventory_event_id uuid NOT NULL REFERENCES inventory_events(id) ON DELETE RESTRICT,
  source_order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  original_quantity numeric(24,9) NOT NULL CHECK (original_quantity > 0),
  remaining_quantity numeric(24,9) NOT NULL CHECK (remaining_quantity >= 0),
  provisional_unit_cost numeric(24,9) NOT NULL CHECK (provisional_unit_cost >= 0),
  is_unpriced boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK (remaining_quantity <= original_quantity),
  CHECK ((remaining_quantity = 0) = (settled_at IS NOT NULL))
);
CREATE INDEX idx_inventory_negative_layers_open
  ON inventory_negative_layers(inventory_item_id, created_at, id)
  WHERE remaining_quantity > 0;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_inventory_event_id_fkey;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_inventory_event_id_fkey
  FOREIGN KEY (inventory_event_id) REFERENCES inventory_events(id) ON DELETE RESTRICT;

DROP VIEW v_inventory_valuation;
CREATE VIEW v_inventory_valuation AS
WITH method AS (
 SELECT l.id location_id, COALESCE(s.value->>'method','fifo') costing_method
 FROM locations l LEFT JOIN settings s ON s.business_id=l.business_id
   AND s.location_id IS NULL AND s.key='inventory.costing'
), stock AS (
 SELECT inventory_item_id, sum(quantity) physical_quantity
 FROM stock_movements GROUP BY inventory_item_id
), lots AS (
 SELECT inventory_item_id, sum(remaining_qty) fifo_available_quantity,
        round(sum(remaining_qty * unit_cost))::bigint gross_carrying_value
 FROM inventory_lots WHERE remaining_qty > 0 GROUP BY inventory_item_id
), negative AS (
 SELECT inventory_item_id, sum(remaining_quantity) negative_layer_quantity
 FROM inventory_negative_layers WHERE remaining_quantity > 0 GROUP BY inventory_item_id
)
SELECT ii.location_id, l.business_id, ii.id inventory_item_id, ii.name item_name, ii.unit,
 COALESCE(s.physical_quantity,0) physical_quantity,
 COALESCE(s.physical_quantity,0) stock_qty,
 m.costing_method, ii.avg_cost weighted_average_cost,
 COALESCE(lo.fifo_available_quantity,0) fifo_available_quantity,
 COALESCE(lo.fifo_available_quantity,0) fifo_lot_qty,
 COALESCE(n.negative_layer_quantity,0) negative_layer_quantity,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.gross_carrying_value,0)
      ELSE round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint END gross_carrying_value,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.gross_carrying_value,0)
      ELSE round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint END carrying_value,
 0::bigint write_down_amount,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.gross_carrying_value,0)
      ELSE round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint END final_valuation,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.gross_carrying_value,0)
      ELSE round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint END valuation,
 COALESCE(s.physical_quantity,0) - COALESCE(lo.fifo_available_quantity,0)
   + COALESCE(n.negative_layer_quantity,0) quantity_mismatch
FROM inventory_items ii JOIN locations l ON l.id=ii.location_id
JOIN method m ON m.location_id=ii.location_id
LEFT JOIN stock s ON s.inventory_item_id=ii.id
LEFT JOIN lots lo ON lo.inventory_item_id=ii.id
LEFT JOIN negative n ON n.inventory_item_id=ii.id
WHERE ii.is_active OR COALESCE(s.physical_quantity,0)<>0
 OR COALESCE(lo.gross_carrying_value,0)<>0 OR COALESCE(n.negative_layer_quantity,0)<>0;

CREATE VIEW v_inventory_gl_reconciliation AS
WITH subledger AS (
 SELECT business_id, sum(final_valuation)::bigint inventory_subledger_value,
        sum(abs(quantity_mismatch)) quantity_mismatch
 FROM v_inventory_valuation GROUP BY business_id
), gl AS (
 SELECT a.business_id, COALESCE(sum(jl.debit-jl.credit),0)::bigint inventory_asset_gl_balance
 FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
 WHERE a.code='1300' GROUP BY a.business_id
), diagnostics AS (
 SELECT b.id business_id,
  (SELECT count(*) FROM inventory_negative_layers nl WHERE nl.business_id=b.id AND nl.remaining_quantity>0) open_negative_layers,
  (SELECT count(*) FROM stock_movements sm JOIN locations l ON l.id=sm.location_id WHERE l.business_id=b.id AND sm.inventory_event_id IS NULL) unlinked_stock_movements,
  (SELECT count(*) FROM journal_entries je WHERE je.business_id=b.id AND je.posting_kind IN ('cogs','receipt','waste','variance') AND je.inventory_event_id IS NULL) unlinked_journal_entries,
  (SELECT count(*) FROM inventory_events ie WHERE ie.business_id=b.id AND ie.posting_status IN ('pending','failed')) pending_failed_events
 FROM businesses b
)
SELECT d.business_id, COALESCE(s.inventory_subledger_value,0) inventory_subledger_value,
 COALESCE(g.inventory_asset_gl_balance,0) inventory_asset_gl_balance,
 COALESCE(s.inventory_subledger_value,0)-COALESCE(g.inventory_asset_gl_balance,0) difference,
 COALESCE(s.quantity_mismatch,0) fifo_lot_on_hand_difference,
 d.open_negative_layers,d.unlinked_stock_movements,d.unlinked_journal_entries,d.pending_failed_events
FROM diagnostics d LEFT JOIN subledger s USING(business_id) LEFT JOIN gl g USING(business_id);
