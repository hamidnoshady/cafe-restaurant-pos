-- ============================================================================
-- 0002_setup_wizard.sql — Phase 1 (Setup Wizard) schema additions
--
--   * Per-category tax rate (percent). The wizard's tax step sets a default
--     VAT rate (stored in settings) and each menu category carries its own
--     effective rate, so exempt categories can be 0 while others follow VAT.
-- ============================================================================

ALTER TABLE menu_categories
    ADD COLUMN tax_rate numeric(5, 2) NOT NULL DEFAULT 0
        CHECK (tax_rate >= 0 AND tax_rate <= 100);
