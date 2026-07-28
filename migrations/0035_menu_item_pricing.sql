-- Cost-plus pricing: an optional per-item target gross margin, overriding the
-- business-wide default (settings key pricing.config) when set. Used by
-- getSuggestedPrice (src/lib/pricing-service.ts) alongside recipe material
-- cost and a ledger-derived overhead recovery rate to suggest a selling price;
-- this column only stores the override, nothing here is auto-applied to price.
ALTER TABLE menu_items
    ADD COLUMN target_margin_percent numeric(5, 2)
        CHECK (target_margin_percent IS NULL OR (target_margin_percent >= 0 AND target_margin_percent < 100));
