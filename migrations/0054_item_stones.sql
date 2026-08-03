-- Phase 21 Wave 4 -- gem/stone attributes as a cost add-on on a jewelry
-- item. One item can carry several stones (e.g. a ring with a center
-- diamond plus accent stones), so this is a child table, not more columns
-- on item_weight_attributes.
--
-- Deliberately does NOT touch item_weight_attributes.net_weight: a stone's
-- carat weight is not auto-converted and subtracted from gross_weight to
-- derive net_weight. Converting carats to grams and assuming it matches
-- what a jeweler actually weighed out (irregular settings, mounting metal
-- around the stone, etc.) would be a fragile approximation nobody asked
-- for -- net_weight stays what it already was since Wave 2: the business's
-- own directly-entered gold-content figure. A stone's `cost` is what
-- actually needs to flow into COGS at sale time (see
-- src/lib/gold-posting-rules.ts's gold.sale_cogs rule, updated in this
-- migration's slice to sum it alongside the metal cost), independent of
-- weight bookkeeping.
CREATE TABLE item_stones (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id    uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    stone_type text NOT NULL,
    carat      numeric(10, 3) NOT NULL CHECK (carat > 0),
    cost       bigint NOT NULL CHECK (cost > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_stones_item ON item_stones (item_id);

ALTER TABLE item_stones ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_stones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stones FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_stones.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_stones.item_id AND app_owns_location(i.location_id)));
