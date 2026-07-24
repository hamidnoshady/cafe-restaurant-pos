-- Customer/supplier returns, two-step transfers, and NRV allowance workflows.

ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'transfer_ship';
ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'transfer_receive';
ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'nrv_reversal';

INSERT INTO accounts(business_id,code,name,type)
SELECT b.id,v.code,v.name,v.type::account_type
FROM businesses b CROSS JOIN (VALUES
 ('1210','Supplier Receivable','asset'),
 ('1350','Inventory in Transit','asset'),
 ('1390','NRV Allowance','asset'),
 ('4400','Sales Returns','revenue'),
 ('5170','Inventory Write-down Expense','expense')
) v(code,name,type)
ON CONFLICT (business_id,code) DO NOTHING;

CREATE TYPE return_disposition AS ENUM ('restockable','discarded');
CREATE TYPE inventory_transfer_status AS ENUM ('draft','shipped','received','cancelled');

CREATE TABLE customer_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  refund_method payment_method NOT NULL,
  refund_amount_rial bigint NOT NULL CHECK (refund_amount_rial >= 0),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  inventory_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,idempotency_key)
);
CREATE TABLE customer_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_return_id uuid NOT NULL REFERENCES customer_returns(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  disposition return_disposition NOT NULL,
  UNIQUE (customer_return_id,order_item_id)
);
CREATE TABLE customer_return_inventory_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_return_line_id uuid NOT NULL REFERENCES customer_return_lines(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  recovered_value_rial bigint NOT NULL CHECK (recovered_value_rial >= 0),
  stock_movement_id bigint REFERENCES stock_movements(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  UNIQUE (customer_return_line_id,inventory_item_id)
);

CREATE OR REPLACE FUNCTION enforce_customer_return_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold numeric(24,9); returned numeric(24,9);
BEGIN
  SELECT quantity INTO sold FROM order_items WHERE id=NEW.order_item_id FOR UPDATE;
  IF sold IS NULL THEN RAISE EXCEPTION 'order_item_not_found'; END IF;
  SELECT COALESCE(sum(l.quantity),0) INTO returned
    FROM customer_return_lines l WHERE l.order_item_id=NEW.order_item_id AND l.id<>NEW.id;
  IF returned + NEW.quantity > sold THEN RAISE EXCEPTION 'return_quantity_exceeds_sold'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_customer_return_quantity
  BEFORE INSERT OR UPDATE ON customer_return_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_customer_return_quantity();

CREATE TABLE supplier_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  purchase_id uuid NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  settlement_method text NOT NULL CHECK (settlement_method IN ('accounts_payable','cash','bank','supplier_receivable')),
  total_value_rial bigint NOT NULL CHECK (total_value_rial >= 0),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  inventory_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,idempotency_key)
);
CREATE TABLE supplier_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_return_id uuid NOT NULL REFERENCES supplier_returns(id) ON DELETE RESTRICT,
  purchase_item_id uuid NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  value_rial bigint NOT NULL CHECK (value_rial >= 0),
  stock_movement_id bigint NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  UNIQUE (supplier_return_id,purchase_item_id,inventory_lot_id)
);
CREATE UNIQUE INDEX uq_supplier_return_weighted_line
  ON supplier_return_lines(supplier_return_id,purchase_item_id)
  WHERE inventory_lot_id IS NULL;

CREATE TABLE inventory_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  source_location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  destination_location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  status inventory_transfer_status NOT NULL DEFAULT 'draft',
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  shipped_by uuid REFERENCES users(id) ON DELETE SET NULL,
  received_by uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  shipped_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  ship_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
  receive_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
  cancel_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,idempotency_key),
  CHECK (source_location_id <> destination_location_id)
);
CREATE TABLE inventory_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES inventory_transfers(id) ON DELETE RESTRICT,
  source_inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  destination_inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  shipped_value_rial bigint,
  UNIQUE (transfer_id,source_inventory_item_id)
);
CREATE TABLE inventory_transfer_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_line_id uuid NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE RESTRICT,
  source_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity numeric(24,9) NOT NULL CHECK (quantity > 0),
  value_rial bigint NOT NULL CHECK (value_rial >= 0),
  original_received_at timestamptz NOT NULL,
  destination_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  UNIQUE (transfer_line_id,source_lot_id)
);

CREATE TABLE inventory_write_downs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  valuation_date date NOT NULL,
  reason text NOT NULL,
  reversal_of uuid REFERENCES inventory_write_downs(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  inventory_event_id uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,idempotency_key)
);
CREATE TABLE inventory_write_down_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  write_down_id uuid NOT NULL REFERENCES inventory_write_downs(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  gross_value_rial bigint NOT NULL CHECK (gross_value_rial >= 0),
  prior_allowance_rial bigint NOT NULL DEFAULT 0 CHECK (prior_allowance_rial >= 0),
  nrv_value_rial bigint NOT NULL CHECK (nrv_value_rial >= 0),
  amount_rial bigint NOT NULL CHECK (amount_rial >= 0),
  UNIQUE (write_down_id,inventory_item_id),
  CHECK (amount_rial = GREATEST(gross_value_rial - prior_allowance_rial - nrv_value_rial,0))
);

CREATE OR REPLACE FUNCTION enforce_nrv_reversal_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_id uuid; original_amount bigint; reversed bigint;
BEGIN
  SELECT reversal_of INTO original_id FROM inventory_write_downs WHERE id=NEW.write_down_id;
  IF original_id IS NULL THEN RETURN NEW; END IF;
  SELECT amount_rial INTO original_amount FROM inventory_write_down_lines
    WHERE write_down_id=original_id AND inventory_item_id=NEW.inventory_item_id FOR UPDATE;
  IF original_amount IS NULL THEN RAISE EXCEPTION 'nrv_original_line_not_found'; END IF;
  SELECT COALESCE(sum(l.amount_rial),0) INTO reversed
    FROM inventory_write_down_lines l JOIN inventory_write_downs w ON w.id=l.write_down_id
   WHERE w.reversal_of=original_id AND l.inventory_item_id=NEW.inventory_item_id AND l.id<>NEW.id;
  IF reversed + NEW.amount_rial > original_amount THEN RAISE EXCEPTION 'nrv_reversal_exceeds_available'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_nrv_reversal_cap
  BEFORE INSERT OR UPDATE ON inventory_write_down_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_nrv_reversal_cap();

CREATE FUNCTION reject_operational_source_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operational accounting source lines are immutable';
END $$;
CREATE TRIGGER trg_customer_return_lines_immutable BEFORE UPDATE OR DELETE ON customer_return_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operational_source_line_mutation();
CREATE TRIGGER trg_customer_return_allocations_immutable BEFORE UPDATE OR DELETE ON customer_return_inventory_allocations
  FOR EACH ROW EXECUTE FUNCTION reject_operational_source_line_mutation();
CREATE TRIGGER trg_supplier_return_lines_immutable BEFORE UPDATE OR DELETE ON supplier_return_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operational_source_line_mutation();
CREATE TRIGGER trg_write_down_lines_immutable BEFORE UPDATE OR DELETE ON inventory_write_down_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operational_source_line_mutation();

CREATE FUNCTION protect_terminal_transfer_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_status inventory_transfer_status;
BEGIN
  IF TG_TABLE_NAME='inventory_transfer_lines' THEN
    SELECT status INTO transfer_status FROM inventory_transfers WHERE id=OLD.transfer_id;
  ELSE
    SELECT t.status INTO transfer_status FROM inventory_transfers t
    JOIN inventory_transfer_lines l ON l.transfer_id=t.id WHERE l.id=OLD.transfer_line_id;
  END IF;
  IF TG_OP='DELETE' OR transfer_status IN ('received','cancelled') THEN
    RAISE EXCEPTION 'terminal transfer source lines are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_transfer_lines_immutable
  BEFORE UPDATE OR DELETE ON inventory_transfer_lines FOR EACH ROW EXECUTE FUNCTION protect_terminal_transfer_lines();
CREATE TRIGGER trg_transfer_allocations_immutable
  BEFORE UPDATE OR DELETE ON inventory_transfer_allocations FOR EACH ROW EXECUTE FUNCTION protect_terminal_transfer_lines();

CREATE VIEW v_active_nrv_allowance AS
WITH original AS (
 SELECT w.id,w.location_id,l.inventory_item_id,l.amount_rial
 FROM inventory_write_downs w JOIN inventory_write_down_lines l ON l.write_down_id=w.id
 WHERE w.reversal_of IS NULL
), reversal AS (
 SELECT w.reversal_of original_id,l.inventory_item_id,sum(l.amount_rial)::bigint reversed
 FROM inventory_write_downs w JOIN inventory_write_down_lines l ON l.write_down_id=w.id
 WHERE w.reversal_of IS NOT NULL GROUP BY w.reversal_of,l.inventory_item_id
)
SELECT o.location_id,o.inventory_item_id,
       sum(o.amount_rial-COALESCE(r.reversed,0))::bigint active_allowance_rial
FROM original o LEFT JOIN reversal r
  ON r.original_id=o.id AND r.inventory_item_id=o.inventory_item_id
GROUP BY o.location_id,o.inventory_item_id;

CREATE VIEW v_inventory_nrv_valuation AS
SELECT v.location_id,v.business_id,v.inventory_item_id,v.item_name,v.unit,
       v.stock_qty,v.physical_quantity,v.costing_method,
       v.gross_carrying_value,
       COALESCE(a.active_allowance_rial,0)::bigint nrv_allowance_rial,
       (v.gross_carrying_value-COALESCE(a.active_allowance_rial,0))::bigint final_valuation,
       (v.gross_carrying_value-COALESCE(a.active_allowance_rial,0))::bigint valuation
FROM v_inventory_valuation v
LEFT JOIN v_active_nrv_allowance a
  ON a.location_id=v.location_id AND a.inventory_item_id=v.inventory_item_id;

DROP VIEW v_inventory_gl_reconciliation;
CREATE VIEW v_inventory_gl_reconciliation AS
WITH subledger AS (
 SELECT business_id,sum(final_valuation)::bigint inventory_subledger_value
 FROM v_inventory_nrv_valuation GROUP BY business_id
), gl AS (
 SELECT a.business_id,
        COALESCE(sum(jl.debit-jl.credit) FILTER (WHERE a.code='1300'),0)::bigint inventory_asset_gl_balance,
        COALESCE(sum(jl.debit-jl.credit) FILTER (WHERE a.code='1390'),0)::bigint nrv_allowance_gl_balance
 FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
 WHERE a.code IN ('1300','1390') GROUP BY a.business_id
)
SELECT b.id business_id,
       COALESCE(s.inventory_subledger_value,0) inventory_subledger_value,
       COALESCE(g.inventory_asset_gl_balance,0) inventory_asset_gl_balance,
       COALESCE(g.nrv_allowance_gl_balance,0) nrv_allowance_gl_balance,
       COALESCE(s.inventory_subledger_value,0)
         -(COALESCE(g.inventory_asset_gl_balance,0)+COALESCE(g.nrv_allowance_gl_balance,0)) difference
FROM businesses b
LEFT JOIN subledger s ON s.business_id=b.id
LEFT JOIN gl g ON g.business_id=b.id;
