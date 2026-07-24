-- Serialize order mutations with checkout and defend order immutability in
-- PostgreSQL. Application code must lock orders first; these triggers are the
-- final guard against an omitted lock in a future write path.

CREATE UNIQUE INDEX uq_payments_one_positive_per_order
  ON payments (order_id)
  WHERE amount > 0;

CREATE OR REPLACE FUNCTION guard_order_item_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order_id uuid;
  parent_status order_status;
  financial_change boolean;
BEGIN
  parent_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;

  SELECT status INTO parent_status
    FROM orders
   WHERE id = parent_order_id
   FOR UPDATE;

  IF parent_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'order_not_found';
  END IF;

  financial_change :=
    TG_OP IN ('INSERT', 'DELETE')
    OR OLD.location_id IS DISTINCT FROM NEW.location_id
    OR OLD.order_id IS DISTINCT FROM NEW.order_id
    OR OLD.menu_item_id IS DISTINCT FROM NEW.menu_item_id
    OR OLD.name_snapshot IS DISTINCT FROM NEW.name_snapshot
    OR OLD.unit_price IS DISTINCT FROM NEW.unit_price
    OR OLD.quantity IS DISTINCT FROM NEW.quantity
    OR (OLD.status IS DISTINCT FROM NEW.status AND (OLD.status = 'voided' OR NEW.status = 'voided'));

  IF financial_change AND parent_status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'order_not_open';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER trg_order_items_financial_guard
  BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_item_financial_mutation();

CREATE OR REPLACE FUNCTION guard_order_item_modifier_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_item_id uuid;
  parent_status order_status;
BEGIN
  parent_item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_item_id ELSE NEW.order_item_id END;

  SELECT o.status INTO parent_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
   WHERE oi.id = parent_item_id
   FOR UPDATE OF o;

  IF parent_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'order_item_not_found';
  END IF;
  IF parent_status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'order_not_open';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER trg_order_item_modifiers_financial_guard
  BEFORE INSERT OR UPDATE OR DELETE ON order_item_modifiers
  FOR EACH ROW EXECUTE FUNCTION guard_order_item_modifier_mutation();
