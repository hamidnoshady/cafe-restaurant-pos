-- Phase 21 Wave 2 -- weight/purity attributes for a tracking='weight' item
-- (gold/jewelry, per Wave 1's items.tracking enum).
--
-- Resolves Phase 21's open question on weight precision: no new numeric
-- convention is introduced here. numeric(24,9) matches the exact-costing
-- precision inventory_lots.remaining_qty already uses (migrations 0012/0015)
-- -- grams need at most 3 decimal places in practice, so this is deliberately
-- generous headroom, not a new decision to get wrong. Money produced by
-- multiplying a weight by a price/gram (Wave 3's pricing engine) rounds
-- through the existing roundRial() (src/lib/inventory-exact.ts), the same
-- rounding rule every other exact posting already uses -- nothing new there
-- either.
--
-- One row per item (net_weight lets Wave 4's stone/gem attributes deduct
-- from gross_weight without a schema change -- net_weight = gross_weight
-- until a stone is recorded against the item).
CREATE TABLE item_weight_attributes (
    item_id      uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    purity       text NOT NULL,
    gross_weight numeric(24, 9) NOT NULL CHECK (gross_weight > 0),
    net_weight   numeric(24, 9) NOT NULL CHECK (net_weight > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (net_weight <= gross_weight)
);

ALTER TABLE item_weight_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_weight_attributes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_weight_attributes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_weight_attributes.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_weight_attributes.item_id AND app_owns_location(i.location_id)));
