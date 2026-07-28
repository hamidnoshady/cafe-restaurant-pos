-- 0036_factory_reset.sql — allow the super-admin's explicitly confirmed,
-- transaction-scoped factory reset to clear otherwise immutable tenant data.
--
-- Normal application writes keep every guard below. `app.factory_reset` is
-- set with set_config(..., true) only by resetBusiness()/hardDeleteBusiness()
-- inside their database transaction, so it is automatically cleared on both
-- COMMIT and ROLLBACK and cannot leak through a pooled connection.

CREATE OR REPLACE FUNCTION app_factory_reset_active() RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.factory_reset', true) = 'true';
$$;

CREATE OR REPLACE FUNCTION guard_order_item_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order_id uuid;
  parent_status order_status;
  financial_change boolean;
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

CREATE OR REPLACE FUNCTION guard_order_item_modifier_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_item_id uuid;
  parent_status order_status;
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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

CREATE OR REPLACE FUNCTION reject_inventory_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'order item inventory snapshots are immutable; create an explicit correction';
END
$$;

CREATE OR REPLACE FUNCTION protect_applied_inventory_cutover()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutover_status inventory_cutover_status;
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'inventory_cutovers' THEN
    cutover_status := OLD.status;
  ELSE
    SELECT status INTO cutover_status FROM inventory_cutovers
     WHERE id=OLD.cutover_id;
  END IF;
  IF cutover_status = 'applied' THEN
    RAISE EXCEPTION 'applied inventory cutover records are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE OR REPLACE FUNCTION reject_operational_source_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'operational accounting source lines are immutable';
END
$$;

CREATE OR REPLACE FUNCTION protect_terminal_transfer_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transfer_status inventory_transfer_status;
BEGIN
  IF app_factory_reset_active() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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
END
$$;
