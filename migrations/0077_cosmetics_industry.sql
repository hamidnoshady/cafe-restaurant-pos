-- Phase 27 Wave 1 — a fifth business type: cosmetics & toiletries
-- («آرایشی و بهداشتی»).
--
-- 0048 pinned the industry list in a CHECK constraint on businesses.industry.
-- Adding a trade is therefore a schema change rather than an enum backfill:
-- the constraint is dropped and re-added with 'cosmetics' included. No
-- backfill — every existing row keeps the value it already has, and
-- provisionBusiness chooses the industry the caller names at creation time.
--
-- Forward-only: 0048_business_industry.sql is never edited.

ALTER TABLE businesses DROP CONSTRAINT businesses_industry_check;

ALTER TABLE businesses ADD CONSTRAINT businesses_industry_check
    CHECK (industry IN ('food_service', 'jewelry', 'watch', 'accessories', 'cosmetics'));
