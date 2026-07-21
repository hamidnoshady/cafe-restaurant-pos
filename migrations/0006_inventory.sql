-- ============================================================================
-- 0006_inventory.sql — Phase 6 (Inventory)
--
--   * inventory_items, menu_item_ingredients, suppliers, purchases,
--     purchase_items, stock_movements already exist from 0001 (foundation
--     stubbed the Phase 6 tables ahead of time). This migration adds what
--     that stub didn't cover:
--       - inventory_lots: per-receipt remaining-quantity/cost rows so FIFO
--         can consume oldest-first. Only populated/consumed when the
--         business's locked costing method is 'fifo'.
--       - inventory_items.avg_cost: running weighted-average unit cost,
--         updated on every purchase receipt. Only meaningful/maintained
--         when the costing method is 'weighted_average', but present on
--         every item so a read never has to branch on costing method.
--       - inventory_items.purchase_unit / purchase_unit_factor: purchasing
--         happens in a coarser unit than the recipe unit (buy in kg, recipe
--         in g). purchase_unit_factor = how many inventory_items.unit units
--         one purchase_unit is worth; purchases are entered in
--         purchase_unit and converted to the item's base unit before
--         storage, so stock_movements/inventory_lots/purchase_items.quantity
--         all stay in one unit per item — no ambiguity at read time.
--       - modifier_ingredients: Phase 2 Q2 follow-up — a modifier can add or
--         swap ingredients (e.g. "oat milk" = -X dairy milk, +Y oat milk).
--         Signed delta applied on top of the menu item's own recipe.
--       - stock_movements.waste_reason: categorized waste logging, only set
--         when type = 'waste'.
--       - stock_counts / stock_count_lines: periodic physical count entry;
--         completing a count posts one 'adjustment' stock_movement per
--         line with a non-zero variance.
-- ============================================================================

CREATE TYPE waste_reason AS ENUM ('spoilage', 'prep_error', 'customer_return', 'staff_meal', 'other');

ALTER TABLE inventory_items
    ADD COLUMN avg_cost             bigint NOT NULL DEFAULT 0,        -- Rial per unit, weighted average
    ADD COLUMN purchase_unit        text,                             -- e.g. 'kg'; null = same as unit
    ADD COLUMN purchase_unit_factor numeric(14, 4) NOT NULL DEFAULT 1 -- inventory unit per 1 purchase_unit
        CHECK (purchase_unit_factor > 0);

ALTER TABLE stock_movements
    ADD COLUMN waste_reason waste_reason;

-- FIFO lots: one row per receipt (purchase or opening count). remaining_qty
-- is drawn down as sales/waste consume the lot, oldest (received_at) first.
CREATE TABLE inventory_lots (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    remaining_qty     numeric(14, 3) NOT NULL CHECK (remaining_qty >= 0),
    unit_cost         bigint NOT NULL, -- Rial per unit, fixed at receipt
    source_type       text,            -- 'purchase' | 'opening'
    source_id         uuid,
    received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_lots_fifo ON inventory_lots (inventory_item_id, received_at)
    WHERE remaining_qty > 0;

-- Modifier-level recipe impact: signed delta on top of the menu item's own
-- menu_item_ingredients row for the same inventory item (e.g. oat milk swap
-- = a negative row for dairy milk + a positive row for oat milk).
CREATE TABLE modifier_ingredients (
    modifier_id       uuid NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity_delta    numeric(14, 3) NOT NULL CHECK (quantity_delta <> 0),
    PRIMARY KEY (modifier_id, inventory_item_id)
);

CREATE TABLE stock_counts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    note        text,
    counted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    counted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_counts_location ON stock_counts (location_id, counted_at);

CREATE TABLE stock_count_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_count_id    uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    system_qty        numeric(14, 3) NOT NULL, -- stock at time of count, per stock_movements
    counted_qty       numeric(14, 3) NOT NULL,
    variance          numeric(14, 3) NOT NULL  -- counted_qty - system_qty
);
CREATE INDEX idx_stock_count_lines_count ON stock_count_lines (stock_count_id);
