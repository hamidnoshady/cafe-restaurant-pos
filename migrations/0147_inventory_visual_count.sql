-- ============================================================================
-- 0147_inventory_visual_count.sql — شمارش تصویری انبار (visual stock count)
--
-- Camera/photo counting of physical stock, Phase 47. Two tables:
--
--   1. `inventory_item_visual_profiles` — the «برچسب تصویری»: one row per
--      tagged exemplar of an inventory item. The operator photographs a unit
--      (or the AI vision model proposes one), the pure engine in
--      src/lib/vision/ grades it, and the row stores what future counts are
--      matched against: the reference photo (an inline JPEG data URL, the
--      same storage decision as `business.logo` in 0145 — the print agent and
--      the offline story both favour data that travels inside the row), the
--      normalized region {x,y,w,h} of the one unit in it, and the extracted
--      features (jsonb: Lab color signature + tolerance, or a radius ratio)
--      that `countWithProfile` consumes. `source` records who tagged it —
--      'manual' (the operator tapped/boxed one unit) or 'ai' — so a
--      human-tagged reference can be told apart from a model proposal when
--      counts go wrong.
--
--      Capped per item in the API (MAX_PROFILES_PER_ITEM), not by a
--      constraint: eight reference shots of one SKU is a product decision,
--      not an invariant, and the API answers it with a Persian error instead
--      of a 500 from a CHECK.
--
--   2. `inventory_count_scans` — the evidence row. When an operator confirms
--      a count the camera produced, the confirmed number, the method that
--      produced it ('cv_color' | 'cv_round' | 'ai_vision'), the engine's
--      confidence, the boxes it drew, and a small JPEG of what it saw are
--      stored beside the tally they fed. The stock count row remains the
--      financial record (a scan never posts a movement); this row is why a
--      surprised owner can later see *what the camera counted* and how, the
--      same audit-trail reasoning as the AI coworker's runs.
--
--      Evidence images are downscaled by the client to ≤320px JPEG before
--      upload; the API enforces a hard data-URL length ceiling, and this
--      migration backs it with a CHECK so a bug can't quietly grow rows.
--
-- Tenancy: both tables carry business_id and get their RLS policy in this
-- same migration, per the repo convention (src/lib/db.ts).
-- ============================================================================

CREATE TABLE inventory_item_visual_profiles (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    -- Who created the tag: the operator ('manual') or the vision model ('ai').
    source            text NOT NULL CHECK (source IN ('manual', 'ai')),
    -- Which counting engine the features describe (src/lib/vision/count.ts).
    kind              text NOT NULL CHECK (kind IN ('color', 'round')),
    -- Inline JPEG data URL of the reference photo (client downscaled ≤480px).
    image_data_url    text NOT NULL CHECK (char_length(image_data_url) <= 220000),
    -- { x, y, w, h } — the one unit's box as fractions of the photo (0..1).
    region            jsonb NOT NULL,
    -- Engine payload: Lab signature + tolerance (color) or radius ratio (round).
    features          jsonb NOT NULL,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_item_visual_profiles_item
    ON inventory_item_visual_profiles (inventory_item_id);
CREATE INDEX idx_inventory_item_visual_profiles_business
    ON inventory_item_visual_profiles (business_id, created_at DESC);

ALTER TABLE inventory_item_visual_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_item_visual_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_item_visual_profiles FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE inventory_count_scans (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    -- 'cv_color' | 'cv_round' (classical engine) or 'ai_vision' (model count).
    method            text NOT NULL CHECK (method IN ('cv_color', 'cv_round', 'ai_vision')),
    -- The CONFIRMED quantity (operator-reviewed), numeric(14,3) like every
    -- stock quantity in this schema.
    counted_qty       numeric(14, 3) NOT NULL CHECK (counted_qty >= 0),
    -- The engine's own confidence in what it saw, 0..1, recorded before the
    -- operator confirmed — the two together say whether the human agreed or
    -- corrected.
    confidence        numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    -- Detected regions as fractions of the photo: [{ x, y, w, h }, …].
    boxes             jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Inline JPEG data URL of the photo the count came from (≤320px client-side).
    image_data_url    text NOT NULL CHECK (char_length(image_data_url) <= 220000),
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_count_scans_location
    ON inventory_count_scans (location_id, created_at DESC);
CREATE INDEX idx_inventory_count_scans_item
    ON inventory_count_scans (inventory_item_id, created_at DESC);

ALTER TABLE inventory_count_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_count_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_count_scans FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
