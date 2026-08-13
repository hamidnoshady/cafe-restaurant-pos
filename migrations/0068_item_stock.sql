-- Phase 21 Wave 6 -- accessories (بدلیجات): on-hand stock and pricing for
-- Wave 1's variant items.
--
-- Wave 6 was always meant to be the thin one ("mostly UI and accessory-
-- specific configuration on top of Wave 1's variant primitive"), and it
-- almost is: `items`/`item_variant_attributes` already model a product
-- family and its variants. The one thing genuinely missing is that an
-- accessory is *fungible* -- unlike a gold piece (one row, one weight) or a
-- watch (one row, one serial), a variant has a countable quantity on hand
-- and a price, and neither has anywhere to live yet.
--
-- Deliberately NOT a second inventory subsystem: no lots, no stock
-- movements, no FIFO. A moving weighted-average cost per variant is the
-- whole costing model, matching the "prove the simple case first" call this
-- phase already made for gold (one average cost per piece) and watch (one
-- cost per unit). F&B's `inventory_items`/`inventory_lots` engine stays
-- exactly where it is -- per Wave 1's settled scope decision, the two
-- models never merge.
CREATE TABLE item_stock (
    item_id    uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    -- numeric(24,9) for the same reason item_weight_attributes uses it: it
    -- is the precision this schema already spends on quantities
    -- (inventory_lots.remaining_qty), not a new convention. Accessories are
    -- counted in whole units in practice.
    quantity   numeric(24, 9) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    -- Running weighted-average cost per unit (Rial). Nullable until the
    -- first receipt gives it a value; the sale path refuses to sell stock
    -- with no cost basis, exactly like gold and watch.
    unit_cost  bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
    -- The shelf price per unit (Rial, pre-VAT). Nullable so a variant can
    -- exist before it is priced.
    unit_price bigint CHECK (unit_price IS NULL OR unit_price > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE item_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_stock.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_stock.item_id AND app_owns_location(i.location_id)));
