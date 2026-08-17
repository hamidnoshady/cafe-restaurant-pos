-- Phase 27 Wave 7 — sales-staff commission (پورسانت فروشنده).
--
-- A cosmetics or jewellery counter runs on commission, and nothing in the
-- product modelled it: every existing "commission" is a consignor's or an
-- online platform's. `commission_rules` describes what an employee earns
-- (percent or fixed, on net or on margin, scoped by item/brand/category),
-- and `commission_accruals` is the signed ledger of what actually accrued —
-- positive when a sale accrues, negative when a later return reverses it, so
-- a staff report is a SUM and always ties to the payroll liability it posted.
--
-- The accrual is posted through the domain-event engine as a payroll
-- liability (Debit پورسانت فروش, Credit حقوق پرداختنی), never a report-only
-- number. RLS in the same migration for both tables.

-- Payroll liability (2300) is F&B-only today; retail sales staff get it too.
-- پورسانت فروش (5210) is new for every trade.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '2000'
CROSS JOIN (VALUES ('2300', 'حقوق پرداختنی', 'liability')) v(code, name, type)
WHERE b.industry <> 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '5000'
CROSS JOIN (VALUES ('5210', 'پورسانت فروش', 'expense')) v(code, name, type)
ON CONFLICT (business_id, code) DO NOTHING;

CREATE TABLE commission_rules (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('percent', 'fixed')),
    basis        text NOT NULL CHECK (basis IN ('net', 'margin')),
    -- percent rate (0-100) or fixed Rial amount.
    value        bigint NOT NULL CHECK (value >= 0),
    -- Scope; empty arrays mean "everything".
    item_ids     uuid[] NOT NULL DEFAULT '{}',
    brand_ids    uuid[] NOT NULL DEFAULT '{}',
    category_ids uuid[] NOT NULL DEFAULT '{}',
    active_from  date,
    active_to    date,
    priority     integer NOT NULL DEFAULT 0,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_commission_rules_business ON commission_rules (business_id);
CREATE INDEX idx_commission_rules_employee ON commission_rules (employee_id);

ALTER TABLE commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_rules FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE commission_accruals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id      uuid REFERENCES commission_rules(id) ON DELETE SET NULL,
    -- The line the accrual came from: 'retail_invoice' or 'order_item'.
    source_type  text NOT NULL,
    source_id    uuid,
    -- Signed: positive = accrued, negative = reversed by a later return.
    amount       bigint NOT NULL,
    -- The net (or margin) the amount was computed on, for the report's tie-out.
    basis_amount bigint NOT NULL CHECK (basis_amount >= 0),
    entry_id     uuid,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_commission_accruals_business ON commission_accruals (business_id);
CREATE INDEX idx_commission_accruals_employee ON commission_accruals (employee_id);

ALTER TABLE commission_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_accruals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commission_accruals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
