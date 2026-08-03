-- Phase 21 Wave 2 -- daily gold price entry, per purity.
--
-- Manual entry is the baseline (decision from the Phase 21 brainstorm): an
-- owner/manager enters today's price/gram for each purity they deal in.
-- `source` exists so a later, optional external price-feed integration
-- (also decided in the brainstorm -- configurable, not required) has
-- somewhere to record that a price came from a feed instead of a person,
-- without a schema change when that lands. No specific provider is wired up
-- here -- see Phase 21's open questions.
--
-- Business-wide, not per-location: a business follows one market gold price
-- across its branches, the same reasoning Phase 7 used for one consolidated
-- ledger rather than a per-location one.
--
-- One row per (business, purity, day) -- upserted by the service layer, not
-- an append-only log, since "today's price" is a single current fact, not a
-- history of edits within the same day.
CREATE TABLE gold_prices (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    purity         text NOT NULL,
    price_date     date NOT NULL DEFAULT CURRENT_DATE,
    price_per_gram bigint NOT NULL CHECK (price_per_gram > 0),
    source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'external')),
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, purity, price_date)
);
CREATE INDEX idx_gold_prices_business_date ON gold_prices (business_id, price_date);

ALTER TABLE gold_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gold_prices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
