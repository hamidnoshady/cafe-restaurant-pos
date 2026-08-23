-- Physical stock counts (انبارگردانی) for the retail `items` model.
--
-- F&B has had one since Phase 6 (`stock_counts`/`stock_count_lines`); the
-- retail item model never did. A jewellery, watch, accessories or cosmetics
-- shop could receive stock, sell it, transfer it, write it down and mark it
-- down — but had no way to say "we counted the shelf and it does not match",
-- which is the one inventory operation a shop actually performs on a schedule.
--
-- Deliberately NOT a copy of the F&B tables. `item_stock` is a moving
-- weighted-average model with no lots, no FIFO layers and no negative layers
-- (see 0068_item_stock.sql, which chose that on purpose), so a count here is
-- arithmetic on one row per item and needs none of the negative-layer
-- settlement machinery `stock-count-service.ts` carries. Keeping the two apart
-- is what lets this stay small.
--
-- A posted count is a source document with a ledger effect, so it is corrected
-- by reversal rather than edited in place — the same rule Phase 29's production
-- runs and F&B's own counts follow. `reversal_of` marks the reversing row.

CREATE TABLE item_stock_counts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    note        text,
    counted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    counted_at  timestamptz NOT NULL DEFAULT now(),
    -- Set on the reversing row, pointing at the count it undoes.
    reversal_of uuid REFERENCES item_stock_counts(id) ON DELETE RESTRICT,
    -- The variance entry this count posted, when it posted one. Null is normal:
    -- a count that matches the system exactly moves no value.
    entry_id    uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_stock_counts_location ON item_stock_counts (location_id, counted_at DESC);
-- A count can be reversed once; the partial unique index is what enforces it,
-- rather than a read-then-write race in the service.
CREATE UNIQUE INDEX idx_item_stock_counts_reversal ON item_stock_counts (reversal_of)
    WHERE reversal_of IS NOT NULL;

CREATE TABLE item_stock_count_lines (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_count_id uuid NOT NULL REFERENCES item_stock_counts(id) ON DELETE CASCADE,
    item_id        uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    -- numeric(24,9) to match item_stock.quantity exactly — a count that stored
    -- less precision than the stock it corrects would create a variance of its own.
    system_qty     numeric(24, 9) NOT NULL,
    counted_qty    numeric(24, 9) NOT NULL CHECK (counted_qty >= 0),
    variance       numeric(24, 9) NOT NULL, -- counted_qty - system_qty
    -- The weighted-average unit cost the variance was valued at, frozen here so
    -- a reversal undoes the count at the value it actually posted rather than
    -- at whatever the average has since moved to. Null when the item had no
    -- cost basis yet, in which case variance_value is 0.
    unit_cost      bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
    -- Signed Rial: negative = shortage, positive = surplus.
    variance_value bigint NOT NULL,
    UNIQUE (stock_count_id, item_id)
);
CREATE INDEX idx_item_stock_count_lines_count ON item_stock_count_lines (stock_count_id);

ALTER TABLE item_stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock_counts FOR ALL
    USING (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()));

ALTER TABLE item_stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock_count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock_count_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_counts c
         WHERE c.id = item_stock_count_lines.stock_count_id
           AND app_owns_location(c.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM item_stock_counts c
         WHERE c.id = item_stock_count_lines.stock_count_id
           AND app_owns_location(c.location_id)));
