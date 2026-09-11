-- ============================================================================
-- 0143_periodic_inventory_lifo.sql — سیستم ادواری (Periodic) + LIFO
--
-- Two additions to the inventory-costing surface:
--
--   1. LIFO (آخرین وارده، اولین صادره) as a third *perpetual* costing method.
--      LIFO shares FIFO's whole machinery — per-receipt `inventory_lots`,
--      exact Rial values, negative layers — and differs only in consumption
--      order (newest lot first). No schema change is needed for the lots
--      themselves; only the valuation views must learn that a lot-based
--      business can be 'lifo' as well as 'fifo'.
--
--   2. The periodic system (سیستم ادواری کلاسیک), selectable at setup next
--      to the perpetual system the app has always run:
--        * a received purchase posts Debit 5105 «خرید طی دوره» / Credit
--          AP-cash-bank — no stock movement, no lot, no negative layer;
--        * a sale posts revenue only — no per-sale COGS, no stock deduction;
--        * cost of goods sold is recognised once per period by a closing
--          document (this migration's `periodic_closings`): the user counts
--          ending stock, the service values it under the chosen method
--          (میانگین موزون کلاسیک / FIFO / LIFO ادواری) and posts
--          COGS = موجودی اول دوره + خرید طی دوره − موجودی پایان دوره,
--          closing 5105 to zero and restating 1300 to the counted value.
--
-- The account is seeded for every business (the same way 0094 backfilled the
-- shared headings): only a business whose setup chose the periodic system
-- ever posts to it, but keeping the chart uniform means the posting rule is
-- a rule, not a per-industry lookup.
-- ============================================================================

-- «خرید طی دوره» — the periodic system's purchases account. Debited by each
-- received purchase, credited back to zero by the period-close entry.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, '5105', 'خرید طی دوره (سیستم ادواری)', 'expense'::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '5000'
ON CONFLICT (business_id, code) DO NOTHING;

-- ----------------------------------------------------------------------------
-- The period-close document. Immutable once posted (like a stock count): a
-- mistake is corrected by the next period's count, which starts from this
-- one's ending values.
-- ----------------------------------------------------------------------------
CREATE TABLE periodic_closings (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id           uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    -- The day the period ends (inclusive). The next closing's window starts
    -- the day after; the first closing's window covers everything up to it.
    period_end            date NOT NULL,
    -- The costing method the ending inventory was valued under — copied from
    -- the locked setup choice at posting time so the document stays
    -- self-describing even if a future phase adds a formal revaluation.
    method                text NOT NULL CHECK (method IN ('fifo', 'lifo', 'weighted_average')),
    beginning_value_rial  bigint NOT NULL CHECK (beginning_value_rial >= 0),
    purchases_value_rial  bigint NOT NULL CHECK (purchases_value_rial >= 0),
    ending_value_rial     bigint NOT NULL CHECK (ending_value_rial >= 0),
    -- beginning + purchases − ending. May be negative when a count finds
    -- more than the books held (posted as a credit to COGS).
    cogs_value_rial       bigint NOT NULL,
    journal_entry_id      uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
    note                  text,
    created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (cogs_value_rial = beginning_value_rial + purchases_value_rial - ending_value_rial),
    -- One closing per business day per branch; periods can't overlap because
    -- each one starts where the previous ended.
    UNIQUE (location_id, period_end)
);
CREATE INDEX idx_periodic_closings_business ON periodic_closings (business_id, period_end DESC);
CREATE INDEX idx_periodic_closings_location ON periodic_closings (location_id, period_end DESC);

CREATE TABLE periodic_closing_lines (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    closing_id         uuid NOT NULL REFERENCES periodic_closings(id) ON DELETE CASCADE,
    inventory_item_id  uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    counted_qty        numeric(24, 9) NOT NULL CHECK (counted_qty >= 0),
    -- Ending value assigned under the closing's method; the per-unit cost is
    -- derivable (value / qty) and deliberately not stored twice.
    ending_value_rial  bigint NOT NULL CHECK (ending_value_rial >= 0),
    UNIQUE (closing_id, inventory_item_id)
);
CREATE INDEX idx_periodic_closing_lines_closing ON periodic_closing_lines (closing_id);
CREATE INDEX idx_periodic_closing_lines_item ON periodic_closing_lines (inventory_item_id);

-- Row-level security — same shapes as 0141: the header carries business_id
-- (Shape 1), the lines are scoped through their header (Shape 2).
ALTER TABLE periodic_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE periodic_closings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON periodic_closings FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE periodic_closing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE periodic_closing_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON periodic_closing_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM periodic_closings c
         WHERE c.id = periodic_closing_lines.closing_id AND c.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM periodic_closings c
         WHERE c.id = periodic_closing_lines.closing_id AND c.business_id = app_current_business()));

-- ----------------------------------------------------------------------------
-- Valuation views: a lot-based business is now 'fifo' OR 'lifo'. This is
-- 0015's v_inventory_valuation verbatim with the single-method equality
-- replaced by IN ('fifo','lifo'); the dependent NRV/GL-reconciliation views
-- read through it unchanged (same column list, so OR REPLACE suffices).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_inventory_valuation AS
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
 CASE WHEN m.costing_method IN ('fifo','lifo') THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END positive_cost_basis,
 COALESCE(n.negative_provisional_value,0) open_provisional_negative_value,
 CASE WHEN m.costing_method IN ('fifo','lifo') THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) gross_carrying_value,
 CASE WHEN m.costing_method IN ('fifo','lifo') THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) carrying_value,
 0::bigint write_down_amount,
 CASE WHEN m.costing_method IN ('fifo','lifo') THEN COALESCE(lo.positive_cost_basis,0)
      ELSE COALESCE(ii.carrying_value_rial,
           round(GREATEST(COALESCE(s.physical_quantity,0),0)*ii.avg_cost)::bigint) END
   - COALESCE(n.negative_provisional_value,0) final_valuation,
 CASE WHEN m.costing_method IN ('fifo','lifo') THEN COALESCE(lo.positive_cost_basis,0)
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
