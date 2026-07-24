-- Exact quantity/value basis for costing version 2. Legacy rows remain
-- nullable until an approved inventory cutover initializes their values.

DROP VIEW v_inventory_gl_reconciliation;
DROP VIEW v_inventory_valuation;
DROP VIEW v_waste_summary;

ALTER TABLE inventory_items
  ALTER COLUMN reorder_level TYPE numeric(24,9),
  ALTER COLUMN purchase_unit_factor TYPE numeric(24,9),
  ADD COLUMN carrying_value_rial bigint;
ALTER TABLE menu_item_ingredients ALTER COLUMN quantity TYPE numeric(24,9);
ALTER TABLE modifier_ingredients ALTER COLUMN quantity_delta TYPE numeric(24,9);
ALTER TABLE purchase_items ALTER COLUMN quantity TYPE numeric(24,9);
ALTER TABLE stock_movements
  ALTER COLUMN quantity TYPE numeric(24,9),
  ADD COLUMN cost_value_rial bigint;
ALTER TABLE inventory_lots
  ALTER COLUMN remaining_qty TYPE numeric(24,9),
  ADD COLUMN original_quantity numeric(24,9),
  ADD COLUMN original_value_rial bigint,
  ADD COLUMN remaining_value_rial bigint;
ALTER TABLE stock_count_lines
  ALTER COLUMN system_qty TYPE numeric(24,9),
  ALTER COLUMN counted_qty TYPE numeric(24,9),
  ALTER COLUMN variance TYPE numeric(24,9);
ALTER TABLE inventory_events
  ADD COLUMN costing_version smallint NOT NULL DEFAULT 1 CHECK (costing_version IN (1,2));
ALTER TABLE inventory_negative_layers
  ADD COLUMN original_provisional_value_rial bigint,
  ADD COLUMN remaining_provisional_value_rial bigint;

ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lot_exact_value_bounds CHECK (
  (original_quantity IS NULL AND original_value_rial IS NULL AND remaining_value_rial IS NULL)
  OR (
    original_quantity IS NOT NULL AND original_quantity > 0
    AND original_value_rial IS NOT NULL AND original_value_rial >= 0
    AND remaining_value_rial IS NOT NULL AND remaining_value_rial >= 0
    AND remaining_qty <= original_quantity
    AND remaining_value_rial <= original_value_rial
    AND ((remaining_qty = 0) = (remaining_value_rial = 0))
  )
);
ALTER TABLE inventory_negative_layers ADD CONSTRAINT negative_layer_exact_value_bounds CHECK (
  (original_provisional_value_rial IS NULL AND remaining_provisional_value_rial IS NULL)
  OR (
    original_provisional_value_rial IS NOT NULL AND original_provisional_value_rial >= 0
    AND remaining_provisional_value_rial IS NOT NULL AND remaining_provisional_value_rial >= 0
    AND remaining_provisional_value_rial <= original_provisional_value_rial
    AND ((remaining_quantity = 0) = (remaining_provisional_value_rial = 0))
  )
);

CREATE TABLE purchase_receipt_cost_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_event_id uuid NOT NULL REFERENCES inventory_events(id) ON DELETE RESTRICT,
  purchase_item_id uuid NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  allocation_kind text NOT NULL CHECK (allocation_kind IN ('negative_settlement','positive_stock')),
  negative_layer_id uuid REFERENCES inventory_negative_layers(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  actual_value_rial bigint NOT NULL CHECK (actual_value_rial >= 0),
  sequence integer NOT NULL CHECK (sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_item_id, sequence),
  CHECK (
    (allocation_kind = 'negative_settlement' AND negative_layer_id IS NOT NULL AND inventory_lot_id IS NULL)
    OR
    (allocation_kind = 'positive_stock' AND negative_layer_id IS NULL)
  )
);

CREATE TABLE inventory_negative_layer_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_event_id uuid NOT NULL REFERENCES inventory_events(id) ON DELETE RESTRICT,
  purchase_item_id uuid NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
  negative_layer_id uuid NOT NULL REFERENCES inventory_negative_layers(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  provisional_value_rial bigint NOT NULL CHECK (provisional_value_rial >= 0),
  actual_value_rial bigint NOT NULL CHECK (actual_value_rial >= 0),
  difference_rial bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_item_id, negative_layer_id),
  CHECK (difference_rial = actual_value_rial - provisional_value_rial)
);
CREATE INDEX idx_negative_settlements_layer ON inventory_negative_layer_settlements(negative_layer_id);

CREATE OR REPLACE FUNCTION require_v2_exact_inventory_values()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version smallint;
  event_id uuid;
BEGIN
  event_id := COALESCE(
    to_jsonb(NEW)->>'inventory_event_id',
    to_jsonb(NEW)->>'source_inventory_event_id'
  )::uuid;
  IF event_id IS NULL THEN RETURN NEW; END IF;
  SELECT costing_version INTO version FROM inventory_events WHERE id = event_id;
  IF version <> 2 THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'stock_movements' AND (to_jsonb(NEW)->>'cost_value_rial') IS NULL THEN
    RAISE EXCEPTION 'v2 stock movement requires cost_value_rial';
  ELSIF TG_TABLE_NAME = 'inventory_lots'
    AND ((to_jsonb(NEW)->>'original_quantity') IS NULL
      OR (to_jsonb(NEW)->>'original_value_rial') IS NULL
      OR (to_jsonb(NEW)->>'remaining_value_rial') IS NULL) THEN
    RAISE EXCEPTION 'v2 inventory lot requires exact quantity and value';
  ELSIF TG_TABLE_NAME = 'inventory_negative_layers'
    AND ((to_jsonb(NEW)->>'original_provisional_value_rial') IS NULL
      OR (to_jsonb(NEW)->>'remaining_provisional_value_rial') IS NULL) THEN
    RAISE EXCEPTION 'v2 negative layer requires exact provisional value';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_stock_movements_require_v2_value
  BEFORE INSERT OR UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION require_v2_exact_inventory_values();
CREATE TRIGGER trg_inventory_lots_require_v2_value
  BEFORE INSERT OR UPDATE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION require_v2_exact_inventory_values();
CREATE TRIGGER trg_negative_layers_require_v2_value
  BEFORE INSERT OR UPDATE ON inventory_negative_layers
  FOR EACH ROW EXECUTE FUNCTION require_v2_exact_inventory_values();

CREATE VIEW v_waste_summary AS
SELECT sm.location_id, l.business_id,
       (sm.occurred_at AT TIME ZONE l.timezone)::date AS waste_date,
       sm.inventory_item_id, ii.name AS item_name, ii.unit, sm.waste_reason,
       sum(-sm.quantity) AS quantity,
       sum(CASE WHEN sm.cost_value_rial IS NOT NULL THEN sm.cost_value_rial
                ELSE round(-sm.quantity * COALESCE(sm.unit_cost,0))::bigint END) AS cost
FROM stock_movements sm
JOIN locations l ON l.id=sm.location_id
JOIN inventory_items ii ON ii.id=sm.inventory_item_id
WHERE sm.type='waste'
GROUP BY sm.location_id,l.business_id,
         (sm.occurred_at AT TIME ZONE l.timezone)::date,
         sm.inventory_item_id,ii.name,ii.unit,sm.waste_reason;

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
        sum(COALESCE(remaining_value_rial,round(remaining_qty*unit_cost)::bigint))::bigint positive_cost_basis
 FROM inventory_lots WHERE remaining_qty > 0 GROUP BY inventory_item_id
), negative AS (
 SELECT inventory_item_id, sum(remaining_quantity) negative_layer_quantity,
        sum(COALESCE(remaining_provisional_value_rial,
                     round(remaining_quantity*provisional_unit_cost)::bigint))::bigint negative_provisional_value
 FROM inventory_negative_layers WHERE remaining_quantity > 0 GROUP BY inventory_item_id
)
SELECT ii.location_id, l.business_id, ii.id inventory_item_id, ii.name item_name, ii.unit,
 COALESCE(s.physical_quantity,0) physical_quantity,
 COALESCE(s.physical_quantity,0) stock_qty,
 m.costing_method, ii.avg_cost weighted_average_cost,
 COALESCE(lo.fifo_available_quantity,0) fifo_available_quantity,
 COALESCE(lo.fifo_available_quantity,0) fifo_lot_qty,
 COALESCE(n.negative_layer_quantity,0) negative_layer_quantity,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END positive_cost_basis,
 COALESCE(n.negative_provisional_value,0) open_provisional_negative_value,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) gross_carrying_value,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) carrying_value,
 0::bigint write_down_amount,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) final_valuation,
 CASE WHEN m.costing_method='fifo' THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) valuation,
 COALESCE(s.physical_quantity,0)
   - (COALESCE(lo.fifo_available_quantity,0)-COALESCE(n.negative_layer_quantity,0)) quantity_mismatch
FROM inventory_items ii JOIN locations l ON l.id=ii.location_id
JOIN method m ON m.location_id=ii.location_id
LEFT JOIN stock s ON s.inventory_item_id=ii.id
LEFT JOIN lots lo ON lo.inventory_item_id=ii.id
LEFT JOIN negative n ON n.inventory_item_id=ii.id
WHERE ii.is_active OR COALESCE(s.physical_quantity,0)<>0
 OR COALESCE(lo.positive_cost_basis,0)<>0 OR COALESCE(n.negative_provisional_value,0)<>0;

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
