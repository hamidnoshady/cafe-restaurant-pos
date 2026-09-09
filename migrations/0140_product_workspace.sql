-- Phase 42 — the products workspace («مدیریت محصولات») for the retail
-- trade-goods industries (accessories, cosmetics, wholesale, tools_fittings,
-- haberdashery).
--
-- Until now each trade's catalogue lived behind its own page's «کالاها» tab
-- (the shared VariantsSection over `items`/`item_stock`). The workspace gives
-- the catalogue one door with its own sidebar group — add product, product
-- list, price lists, product attributes and weight-barcode templates — and
-- every row below is a *new* concern that board never had:
--
--   * `item_attribute_definitions` — the attribute master («ویژگی محصول»:
--     رنگ with its values عسلی/مشکی/…), which the add-variant form used to
--     free-type per item. Definitions are per location like `items` itself.
--   * `price_lists` + `price_list_entries` — named shelf-price columns
--     (عمده/همکار/…) beside `item_stock.unit_price`, which stays the sale
--     price the invoice screen reads. Entries reference `items` rows.
--   * `weight_barcode_templates` — the EAN-13 weight-barcode patterns
--     (prefix + weight unit) the «الگوی بارکد وزنی» screen manages.
--   * additive product columns on `items` (barcode, units, ordering hints,
--     tax percents, sellability) so the add-product form's tabs write real
--     data instead of being decoration. All nullable; jewellery/watch simply
--     never fill them.
--
-- Every new tenant-scoped table carries its RLS policy in this same
-- migration, mirroring the `items` policies from 0050.

-- ── Attribute master («ویژگی محصول») ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_attribute_definitions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    -- The values this attribute can take (رنگ → عسلی، مشکی، …). An empty
    -- array means the add form offers a free-text value.
    options     text[] NOT NULL DEFAULT '{}',
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);
CREATE INDEX IF NOT EXISTS idx_item_attribute_definitions_location
    ON item_attribute_definitions (location_id);

ALTER TABLE item_attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_attribute_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_attribute_definitions FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- ── Named price lists («لیست قیمت») ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_lists (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    -- ISO 4217; the platform displays Toman text but stores Rial, and a list
    -- names its currency the way the reference panel labels it (IRR).
    currency    text NOT NULL DEFAULT 'IRR',
    sort        integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);
CREATE INDEX IF NOT EXISTS idx_price_lists_location ON price_lists (location_id);

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON price_lists FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

CREATE TABLE IF NOT EXISTS price_list_entries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
    item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    price         bigint NOT NULL CHECK (price >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (price_list_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_price_list_entries_list ON price_list_entries (price_list_id);
CREATE INDEX IF NOT EXISTS idx_price_list_entries_item ON price_list_entries (item_id);

ALTER TABLE price_list_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON price_list_entries FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM price_lists pl
         WHERE pl.id = price_list_entries.price_list_id AND app_owns_location(pl.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM price_lists pl
         WHERE pl.id = price_list_entries.price_list_id AND app_owns_location(pl.location_id)));

-- ── Weight barcode templates («الگوی بارکد وزنی») ───────────────────────────
-- One row per EAN-13 weight pattern: the fixed two-digit prefix (PP) the
-- scale prints, and the unit the five weight digits (WWWWW) are measured in.
-- The item reference and check digit are computed at print time, so the
-- template is exactly the two choices the screen offers.
CREATE TABLE IF NOT EXISTS weight_barcode_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    prefix      text NOT NULL,
    weight_unit text NOT NULL DEFAULT 'grams'
                CHECK (weight_unit IN ('grams', 'kilograms')),
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, prefix)
);
CREATE INDEX IF NOT EXISTS idx_weight_barcode_templates_location
    ON weight_barcode_templates (location_id);

ALTER TABLE weight_barcode_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_barcode_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weight_barcode_templates FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

-- ── Additive product columns on the shared item core ────────────────────────
ALTER TABLE items
    ADD COLUMN IF NOT EXISTS barcode text,
    ADD COLUMN IF NOT EXISTS unit text,
    ADD COLUMN IF NOT EXISTS sub_unit text,
    ADD COLUMN IF NOT EXISTS conversion_factor numeric(24, 9)
        CHECK (conversion_factor IS NULL OR conversion_factor > 0),
    ADD COLUMN IF NOT EXISTS min_order_qty numeric(24, 9)
        CHECK (min_order_qty IS NULL OR min_order_qty >= 0),
    ADD COLUMN IF NOT EXISTS reorder_reminder_qty numeric(24, 9)
        CHECK (reorder_reminder_qty IS NULL OR reorder_reminder_qty >= 0),
    ADD COLUMN IF NOT EXISTS lead_time_days integer
        CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
    ADD COLUMN IF NOT EXISTS storage_location text,
    ADD COLUMN IF NOT EXISTS tax_sale_percent numeric(5, 2)
        CHECK (tax_sale_percent IS NULL OR tax_sale_percent >= 0),
    ADD COLUMN IF NOT EXISTS tax_purchase_percent numeric(5, 2)
        CHECK (tax_purchase_percent IS NULL OR tax_purchase_percent >= 0),
    ADD COLUMN IF NOT EXISTS is_sellable boolean NOT NULL DEFAULT true;
