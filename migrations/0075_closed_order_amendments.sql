-- Closed-order amendments (edit / remove after checkout).
--
-- A completed order is a source document: it has posted revenue, VAT, tips,
-- platform commission, an AR balance when it was sold on credit, an exact
-- inventory consumption and a COGS entry. So it is never mutated in place.
-- Correcting one is modelled exactly the way a posted stock count is
-- (migration 0072, src/lib/stock-count-service.ts): a reversal that undoes
-- the original at its own recorded values, optionally followed by a fresh
-- replay of the corrected order.
--
-- The reversal and the replay are both dated on the *original* order's
-- posting date rather than today, so the day the sale belongs to is the day
-- it disappears from — otherwise "remove this order" would leave yesterday's
-- sales report unchanged and drop a mystery reversal into today's. The
-- fiscal-period lock trigger (migration 0024) still governs whether that date
-- may be posted into at all, so a locked month refuses the amendment rather
-- than quietly rewriting a closed period.

ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'sale_reversal';

CREATE TYPE order_amendment_kind AS ENUM ('edit', 'void');

CREATE TABLE order_amendments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind              order_amendment_kind NOT NULL,
    reason            text NOT NULL,
    -- The order (header + lines) as it stood immediately before and after the
    -- amendment. order_items rows are edited in place by an amendment, so this
    -- is the only record of what the bill actually said when it was paid.
    before_snapshot   jsonb NOT NULL,
    after_snapshot    jsonb NOT NULL,
    previous_total    bigint NOT NULL,
    new_total         bigint NOT NULL,
    previous_tip      bigint NOT NULL DEFAULT 0,
    new_tip           bigint NOT NULL DEFAULT 0,
    -- The date the reversal/replay entries were posted on: the original order's
    -- own posting date, not the date the correction was made.
    entry_date        date NOT NULL,
    -- The consumption this amendment undid, and the one it posted in its place
    -- ('void' has no replay, so that column stays null).
    reversal_event_id uuid REFERENCES inventory_events(id) ON DELETE RESTRICT,
    replay_event_id   uuid REFERENCES inventory_events(id) ON DELETE RESTRICT,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_amendments_order ON order_amendments (order_id, created_at);
CREATE INDEX idx_order_amendments_business ON order_amendments (business_id, created_at DESC);

ALTER TABLE order_amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_amendments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_amendments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Marks an order whose closed state has been corrected at least once, so the
-- orders screen and the receipt can say so without a join.
ALTER TABLE orders
    ADD COLUMN amended_at timestamptz,
    ADD COLUMN amended_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Making room for an amendment in migration 0014's immutability guards
-- ---------------------------------------------------------------------------
-- 0014 froze a settled order's lines at the database, precisely so a future
-- write path that forgot to lock the order could not quietly restate a paid
-- bill. An amendment is the one write that is *supposed* to, and it is not
-- exempt from the reason that guard exists — it takes the same `FOR UPDATE`
-- lock on the order first, then reverses and re-posts every effect.
--
-- So rather than dropping the guard, the amendment announces itself: it sets
-- `app.order_amendment` for the duration of its transaction, the same
-- explicit, greppable shape `app.rls_bypass` uses for the tenant boundary.
-- Nothing else in the codebase sets it — grep for `app.order_amendment` to
-- audit every place a closed order's lines may legally move.
CREATE OR REPLACE FUNCTION app_order_amendment_in_progress() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT coalesce(current_setting('app.order_amendment', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION guard_order_item_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order_id uuid;
  parent_status order_status;
  financial_change boolean;
BEGIN
  -- Migration 0036's escape hatch, unchanged: a factory reset tears the whole
  -- tenant down and is not a restatement of anything.
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

  IF financial_change AND parent_status <> 'open' AND NOT app_order_amendment_in_progress() THEN
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
  IF parent_status <> 'open' AND NOT app_order_amendment_in_progress() THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'order_not_open';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

-- ---------------------------------------------------------------------------
-- "One live settlement per order", rather than "one positive payment ever"
-- ---------------------------------------------------------------------------
-- 0014's `uq_payments_one_positive_per_order` exists so a concurrent checkout
-- cannot charge the same bill twice. An amendment re-settles the corrected
-- bill, which means a second positive row — but not a second *live* one: the
-- row it replaces is cancelled by a matching negative row and stamped here,
-- and the index is narrowed to the rows that still stand. The guarantee is
-- unchanged, and it is now expressed as what it always meant.
ALTER TABLE payments
    ADD COLUMN superseded_by_amendment_id uuid REFERENCES order_amendments(id) ON DELETE SET NULL;
CREATE INDEX idx_payments_superseded ON payments (superseded_by_amendment_id)
    WHERE superseded_by_amendment_id IS NOT NULL;

DROP INDEX uq_payments_one_positive_per_order;
CREATE UNIQUE INDEX uq_payments_one_positive_per_order
  ON payments (order_id)
  WHERE amount > 0 AND superseded_by_amendment_id IS NULL;
