-- Phase 27 Wave 5 — loyalty, store credit and a customer worth having.
--
-- `customers` today is name/phone/address/notes/is_active and nothing else,
-- so the first half is giving a customer the fields a loyalty programme
-- needs (email, birthday, tags, consent). `customers` is already
-- business-scoped (migration 0021, Shape 1), so these columns inherit its
-- policy and no new policy is added — stated explicitly so the next reader
-- does not look for one.
--
-- The second half is the loyalty ledger. Points are a signed ledger over
-- `customer_points` (earn positive, redeem negative), so a balance is a SUM
-- and the two directions net to zero by construction — never a mutable
-- number in a column. Store credit is deliberately *not* a column at all: it
-- is a liability account (2410) posted through the domain-event engine, and
-- a customer's credit balance is reconstructed from those events, the same
-- "what is owed to a consignor" discipline consignment-service.ts follows.

ALTER TABLE customers
    ADD COLUMN email text,
    -- Stored ISO/Gregorian (the repo's date convention); rendered Jalali.
    ADD COLUMN birthday date,
    -- Skin/hair-type tags, mirroring items.tags (Wave 3), feeding the
    -- repeat-purchase engine and customer segmentation.
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
    -- Consent flags, defaulted off: a shop must opt a customer in.
    ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false,
    ADD COLUMN sms_consent boolean NOT NULL DEFAULT false;

-- Store-credit liability, added to every business regardless of trade — every
-- industry can hold customer credit.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '2000'
CROSS JOIN (VALUES ('2410', 'اعتبار فروشگاهی', 'liability')) v(code, name, type)
ON CONFLICT (business_id, code) DO NOTHING;

-- The debit side of issuing credit: «برگشت از فروش» (contra-revenue). F&B's
-- template already has it; the four retail templates gain it here, and it is
-- backfilled onto every existing retail business. Wave 8's returns reuse it.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, v.is_contra
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '4000'
CROSS JOIN (VALUES ('4400', 'برگشت از فروش', 'revenue', true)) v(code, name, type, is_contra)
WHERE b.industry <> 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

CREATE TABLE loyalty_programs (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id          uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name                 text NOT NULL,
    -- Points earned per 100,000 Rial (= 10,000 Toman) of spend — the unit a
    -- shop owner actually thinks in, kept in whole points.
    earn_points_per_100000 integer NOT NULL DEFAULT 1 CHECK (earn_points_per_100000 >= 0),
    -- Rial value of one point at redemption.
    point_value_rial      integer NOT NULL DEFAULT 1000 CHECK (point_value_rial > 0),
    -- Days until earned points lapse; null = never expire.
    points_expiry_days    integer CHECK (points_expiry_days IS NULL OR points_expiry_days > 0),
    is_active             boolean NOT NULL DEFAULT true,
    is_default            boolean NOT NULL DEFAULT false,
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, name)
);

-- One default program per business, expressed as a constraint rather than a
-- convention so the earn path can always find its program.
CREATE UNIQUE INDEX one_default_loyalty_program_per_business
    ON loyalty_programs (business_id) WHERE is_default;

CREATE TABLE customer_points (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- ON DELETE RESTRICT: a customer with points can never be hard-deleted,
    -- the same rule ar_receipts enforces for financial history.
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    -- Signed: positive = earned, negative = redeemed. Balance = SUM(points).
    points      integer NOT NULL CHECK (points <> 0),
    source_type text NOT NULL,
    source_id   uuid,
    expires_at  date,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_loyalty_programs_business ON loyalty_programs (business_id);
CREATE INDEX idx_customer_points_business ON customer_points (business_id);
CREATE INDEX idx_customer_points_customer ON customer_points (customer_id);

ALTER TABLE loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_programs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_programs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE customer_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_points FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_points FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
