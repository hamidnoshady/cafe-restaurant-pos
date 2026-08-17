-- Phase 27 Wave 3 — cosmetics merchandising and regulatory identity.
--
-- «برند» becomes a first-class filter and report axis (and, in Wave 7, a
-- commission basis), so it gets a table rather than a free-text column on
-- every item: a brand is a shared value a shop enters once and attaches.
-- Regulatory fields for the Iranian market (کد IRC / پروانه بهداشت /
-- ثبت اصالت کالا) are stored on the item and printed on the invoice when
-- present — a shop that does not track them sees no change. Skin/hair-type
-- tags ride on the item as a text array, feeding Wave 5's repeat-purchase
-- engine.
--
-- RLS in the same migration: item_brands is scoped through its own
-- location_id; the new items columns inherit items' existing policy.

CREATE TABLE item_brands (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name         text NOT NULL,
    -- کشور سازنده — printed next to the brand and used as a report axis.
    country      text,
    -- Product line (خط تولید), optional.
    product_line text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);

CREATE INDEX idx_item_brands_location ON item_brands (location_id);

ALTER TABLE item_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_brands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_brands FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

ALTER TABLE items
    ADD COLUMN brand_id uuid REFERENCES item_brands(id) ON DELETE SET NULL,
    -- کد IRC / پروانه بهداشت / ثبت اصالت کالا — printed on the invoice when set.
    ADD COLUMN irc_code text,
    ADD COLUMN health_permit text,
    ADD COLUMN authenticity_registration text,
    -- Skin/hair-type tags, e.g. {پوست چرب، موی رنگ‌شده}.
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_items_brand ON items (brand_id) WHERE brand_id IS NOT NULL;
