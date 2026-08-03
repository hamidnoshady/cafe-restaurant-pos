-- Phase 21 Wave 1 — multi-industry core: the industry discriminator.
--
-- Every business created before this migration is food & beverage; the
-- DEFAULT below backfills them all in the same statement. Unlike the
-- inventory-costing method (Phase 1), which starts mutable and is locked by
-- a separate step once it's actually been used, industry has no such window:
-- the very first wizard step after business creation (chart of accounts)
-- already needs to know it. So it is set exactly once, at business creation
-- (provisionBusiness, src/lib/business-provisioning.ts), and no update route
-- is ever exposed for it — immutable by omission rather than by a lock flag.
--
-- Only 'food_service' is fully wired as of this migration. The other three
-- values exist now so later waves (jewelry/gold in Waves 2-4, watch in Wave
-- 5, accessories in Wave 6) don't need another schema change to introduce
-- them; the setup wizard only offers 'food_service' until each one's own
-- wave lands its chart-of-accounts template and dedicated wizard steps.
ALTER TABLE businesses
    ADD COLUMN industry text NOT NULL DEFAULT 'food_service'
        CHECK (industry IN ('food_service', 'jewelry', 'watch', 'accessories'));
