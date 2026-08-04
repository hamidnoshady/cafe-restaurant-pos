-- Phase 21 Wave 1 -- generic Item/Variant/Serial primitive.
--
-- A shared "sellable thing" model so gold/jewelry (Wave 2-4), watch
-- (Wave 5), and accessories (Wave 6) don't each invent their own item
-- table -- a watch is a serialized item, an accessory is a variant-child
-- item, and a weighted gold piece (Wave 2) attaches its own weight/purity
-- attributes on top of the same `items` row. Weight/purity themselves are
-- NOT part of this migration: they're Wave 2's job, once fractional-weight
-- precision and rounding are actually decided (see Phase 21's open
-- questions) rather than guessed at here.
--
-- Deliberately NOT linked from menu_items/inventory_items yet. Migrating
-- F&B's own recipe/menu model onto this primitive without changing its
-- observable behavior is real, careful work that deserves its own slice and
-- its own review, once this primitive itself has shipped and proven out.
CREATE TABLE items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    parent_item_id uuid REFERENCES items(id) ON DELETE CASCADE,
    name           text NOT NULL,
    sku            text,
    -- 'simple': an ordinary standalone item.
    -- 'variant_parent': a product family (e.g. "دستبند بدلیجات") whose sellable
    --   units are its variant_child rows, each with its own attribute set
    --   (item_variant_attributes) -- Wave 6's accessories module builds on this.
    -- 'variant_child': one sellable variant of a variant_parent.
    kind           text NOT NULL DEFAULT 'simple'
                     CHECK (kind IN ('simple', 'variant_parent', 'variant_child')),
    -- 'none': ordinary stock, no per-unit identity (today's inventory_items
    --   shape). 'serial': one physical unit per row (item_serials) -- Wave 5's
    --   watches. 'weight': Wave 2 attaches weight/purity attributes on top.
    tracking       text NOT NULL DEFAULT 'none'
                     CHECK (tracking IN ('none', 'serial', 'weight')),
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK ((parent_item_id IS NULL) = (kind <> 'variant_child'))
);
CREATE INDEX idx_items_location ON items (location_id);
CREATE INDEX idx_items_parent ON items (parent_item_id);

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON items FOR ALL
    USING (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR location_id IN (
        SELECT l.id FROM locations l WHERE l.business_id = app_current_business()));

-- One row per variant axis value on a variant_child item (e.g. name='رنگ',
-- value='قرمز'). A variant_parent carries none of these itself -- its
-- children each carry the full set that distinguishes them.
CREATE TABLE item_variant_attributes (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    name    text NOT NULL,
    value   text NOT NULL,
    UNIQUE (item_id, name)
);

ALTER TABLE item_variant_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_variant_attributes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_variant_attributes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_variant_attributes.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_variant_attributes.item_id AND app_owns_location(i.location_id)));

-- One row per physical serialized unit of a tracking='serial' item (Wave 5:
-- watches). Deliberately carries no link to orders/sales yet -- that
-- lifecycle (sold/warranty/repair) is Wave 5's own design, not guessed at
-- here; this migration only needs the identity + status of the unit itself.
CREATE TABLE item_serials (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    serial_number text NOT NULL,
    status        text NOT NULL DEFAULT 'in_stock'
                    CHECK (status IN ('in_stock', 'reserved', 'sold', 'in_repair')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (item_id, serial_number)
);

ALTER TABLE item_serials ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_serials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_serials FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_serials.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_serials.item_id AND app_owns_location(i.location_id)));
