-- Phase 21 Wave 4 -- consignment (امانی): goods a third party (the
-- consignor) brought in for the shop to sell on their behalf. Deliberately
-- off the business's own balance sheet -- there is no inventory-asset
-- posting when a consigned item is intaken, and no COGS posting when it
-- sells (src/lib/gold-posting-rules.ts's new gold.consignment_sale_revenue
-- rule skips COGS entirely, unlike an owned-inventory sale) -- the shop
-- never owned it.
--
-- `consignors` mirrors `customers` (migration 0001) exactly: same shape,
-- same Shape 1 (business_id direct) RLS.
CREATE TABLE consignors (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
    name        text NOT NULL,
    phone       text,
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consignors_business ON consignors (business_id);

ALTER TABLE consignors ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consignors FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- One row per consigned item (1:1, mirrors item_weight_attributes). No
-- pre-agreed commission column: the sale-time inputs to the pricing engine
-- (making charge / profit / VAT percents, already how an owned-inventory
-- sale works since Wave 3) are reused as-is for a consigned sale too --
-- profit becomes the shop's commission at the point of sale, not a rate
-- fixed at intake.
CREATE TABLE item_consignments (
    item_id      uuid PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    consignor_id uuid NOT NULL REFERENCES consignors(id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_consignments_consignor ON item_consignments (consignor_id);

ALTER TABLE item_consignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_consignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_consignments FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_consignments.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_consignments.item_id AND app_owns_location(i.location_id)));
