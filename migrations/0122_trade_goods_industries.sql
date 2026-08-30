-- Phase 38 — add the three trade-goods industries to businesses.industry.
--
-- `wholesale`, `tools_fittings` and `haberdashery` are full retail-invoice
-- trades: they sell from `items`/`item_stock`, post through their own trade
-- posting rules and charts of accounts, and use the shared `stock` module for
-- purchases/transfers/counts. The CHECK constraint in migration 0048 was
-- written when only four industries existed, so it must be widened here.
--
-- Additive and idempotent: dropping the old constraint and re-adding the wider
-- one keeps existing food_service/jewelry/watch/accessories/cosmetics rows
-- untouched. PostgreSQL names the inline CHECK from 0048
-- `businesses_industry_check`; IF EXISTS makes this safe to re-run on a schema
-- where a future migration has already widened or replaced it.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_industry_check;
ALTER TABLE businesses
    ADD CONSTRAINT businesses_industry_check
    CHECK (industry IN (
        'food_service',
        'jewelry',
        'watch',
        'accessories',
        'cosmetics',
        'wholesale',
        'tools_fittings',
        'haberdashery'
    ));
