-- ---------------------------------------------------------------------------
-- Fixed-asset register & depreciation (Phase 22 Wave 5, second slice,
-- issue #160 §2)
-- ---------------------------------------------------------------------------
-- Straight-line only for v1 — the simplest default, matching every other
-- phase's "start simple, revisit if asked" pattern; no declining-balance,
-- units-of-production, or disposal/sale-of-asset workflow yet.
--
-- accumulated_depreciation is never stored on the asset row — reconstructed
-- from fixed_asset_depreciation_entries, the same "never a shadow copy"
-- discipline AR/AP/VAT already use for their control-account balances.

CREATE TABLE fixed_assets (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id        uuid REFERENCES locations(id) ON DELETE SET NULL,
    name               text NOT NULL,
    acquisition_date   date NOT NULL,
    cost               bigint NOT NULL CHECK (cost > 0),
    salvage_value      bigint NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
    useful_life_months integer NOT NULL CHECK (useful_life_months > 0),
    created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (salvage_value < cost)
);
CREATE INDEX idx_fixed_assets_business ON fixed_assets (business_id);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_assets FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- One row per posted depreciation period for one asset — the link to the
-- journal entry it caused is one-directional via
-- journal_entries.source_type = 'fixed_asset_depreciation' / source_id,
-- mirroring ar_receipts/ap_payments/payroll_runs. UNIQUE(fixed_asset_id,
-- period_label) guards against posting the same period twice by accident —
-- stricter than payroll_runs' free-text period_label (nothing there stops
-- a second accrual for the same label), since a depreciation amount is
-- fully deterministic and there's no legitimate reason to repeat one.
CREATE TABLE fixed_asset_depreciation_entries (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fixed_asset_id uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    period_label   text NOT NULL,
    entry_date     date NOT NULL,
    amount         bigint NOT NULL CHECK (amount > 0),
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (fixed_asset_id, period_label)
);
CREATE INDEX idx_fixed_asset_depr_asset ON fixed_asset_depreciation_entries (fixed_asset_id);

ALTER TABLE fixed_asset_depreciation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_depreciation_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_asset_depreciation_entries FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM fixed_assets fa
         WHERE fa.id = fixed_asset_depreciation_entries.fixed_asset_id
           AND fa.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM fixed_assets fa
         WHERE fa.id = fixed_asset_depreciation_entries.fixed_asset_id
           AND fa.business_id = app_current_business()));

-- New well-known accounts, backfilled onto every existing food_service
-- business (jewelry stays out of scope for this slice, same as Wave 4's
-- channel-revenue accounts): accumulated depreciation (contra-asset, a
-- child of 1500 اثاثه و تجهیزات — the only fixed-asset line the template
-- has today) and depreciation expense.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'moein'::account_level, true
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '1500'
CROSS JOIN (VALUES
  ('1510', 'استهلاک انباشته', 'asset')
) v(code, name, type)
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '5000'
CROSS JOIN (VALUES
  ('5700', 'هزینه استهلاک', 'expense')
) v(code, name, type)
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;
