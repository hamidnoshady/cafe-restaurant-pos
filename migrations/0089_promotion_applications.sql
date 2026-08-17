-- Phase 27 Wave 13 — promotion applications.
--
-- The shared promotion engine (src/lib/promotions.ts) decides the per-line
-- discount at sale time, but until now nothing recorded *which* promotion
-- fired, so "promotion effectiveness" was not a question the database could
-- answer. This table records one row per promotion application, keyed to the
-- sale it touched, so the Wave 13 report can rank campaigns by how often they
-- fired and how much discount they cost.
--
-- RLS in the same migration, scoped by business_id like the promotions
-- catalogue itself.

CREATE TABLE promotion_applications (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    promotion_id  uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
    -- What the application discounted: an order (F&B) or an invoice order.
    source_type   text NOT NULL,
    source_id     uuid NOT NULL,
    discount_rial bigint NOT NULL CHECK (discount_rial > 0),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_promotion_applications_business ON promotion_applications (business_id);
CREATE INDEX idx_promotion_applications_promotion ON promotion_applications (promotion_id);

ALTER TABLE promotion_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON promotion_applications FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
