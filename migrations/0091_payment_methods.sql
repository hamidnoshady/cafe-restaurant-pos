-- 0091_payment_methods.sql — named payment ways, and splitting one bill across
-- several of them.
--
-- Two things change here, and they are the same change seen from two sides.
--
-- 1. A *payment way* becomes a row a business owns, not a value baked into the
--    `payment_method` enum. A café that takes «کیف پول آسان‌پرداخت» or has two
--    card terminals it wants told apart on the cash-up can add them, name them
--    in its own words, and order them the way its cashiers reach for them.
--    What it cannot invent is how a way *settles*: every method still resolves
--    to one of the enum's settlement classes, because that is what the ledger
--    understands (cash box, bank clearing, receivable, platform receivable).
--    So `settlement` stays the enum, and `name`/`sort_order`/`is_active` are
--    the business's own.
--
-- 2. `payments` already allowed many rows per order — nothing ever wrote more
--    than one. Splitting a bill (۲۰۰٬۰۰۰ نقدی + ۳۰۰٬۰۰۰ کارت‌خوان) is exactly
--    one row per tender, so the only schema this needs is a pointer from a
--    payment to the way it was taken. `payment_method_id` is nullable and the
--    enum column stays authoritative for settlement: every row written before
--    today (and every row an amendment, a refund or the WooCommerce ingest
--    writes without picking a named way) keeps working unchanged, and every
--    report that filters on `p.method = 'cash'` keeps returning the same
--    numbers.
--
-- Built-ins are seeded per business rather than left implicit so that ordering
-- and renaming have something to act on: an owner who wants «نسیه» first, or
-- «کارت‌خوان» renamed to «پوز بانک ملت», edits a row instead of needing a new
-- settings key. They are marked `is_builtin` so the API can refuse to delete
-- the ways the rest of the app names by code (cash, credit, snappfood).

CREATE TABLE payment_methods (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Stable slug, never shown to a user. Built-ins use the enum's own value
    -- as their code, which is what lets the seed below (and the app) map an
    -- existing payment's `method` onto its named way.
    code          text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_]{0,31}$'),
    -- The Persian name the cashier reads. Editable, including on built-ins.
    name          text NOT NULL CHECK (btrim(name) <> ''),
    -- How the money lands, in the ledger's terms. Not editable once payments
    -- exist against the way (enforced in the service, not here).
    settlement    payment_method NOT NULL,
    -- Ascending; ties break by name. This is the "order of showing the payment
    -- ways" the checkout screens honour.
    sort_order    integer NOT NULL DEFAULT 0,
    -- Retired ways stay for history's sake and stop being offered.
    is_active     boolean NOT NULL DEFAULT true,
    is_builtin    boolean NOT NULL DEFAULT false,
    -- Whether taking money this way opens the cash drawer and counts toward
    -- the till at cash-up. True for cash, and for anything a business models
    -- on cash (a tip jar, a petty-cash float).
    opens_drawer  boolean NOT NULL DEFAULT false,
    -- Whether the cashier must type a reference (terminal trace no., last four
    -- digits, transfer id) before the payment is accepted.
    requires_reference boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, code)
);

CREATE INDEX idx_payment_methods_business ON payment_methods (business_id, sort_order);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_methods FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The four ways every trade has. Ordered the way a till is reached for.
INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
SELECT b.id, v.code, v.name, v.code::payment_method, v.sort_order, true, v.code = 'cash'
  FROM businesses b
 CROSS JOIN (VALUES
     ('cash',         'نقدی',           10),
     ('card',         'کارت‌خوان',       20),
     ('card_to_card', 'کارت‌به‌کارت',    30),
     ('online',       'پرداخت آنلاین',  40),
     ('credit',       'نسیه',           50)
 ) AS v(code, name, sort_order)
ON CONFLICT (business_id, code) DO NOTHING;

-- SnapFood settles through its own receivable and its own commission expense
-- (migration 0060), which only a food-service business has a chart of accounts
-- for.
INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
SELECT b.id, 'snappfood', 'اسنپ‌فود', 'snappfood'::payment_method, 60, true, false
  FROM businesses b
 WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- A payment records which named way took it.
-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL, not RESTRICT: a business that deletes an unused way must
-- not be able to strand a historical payment, and a payment that loses its way
-- still knows how it settled from `method`.
ALTER TABLE payments
    ADD COLUMN payment_method_id uuid REFERENCES payment_methods(id) ON DELETE SET NULL;

CREATE INDEX idx_payments_payment_method ON payments (payment_method_id);

-- Backfill: every existing payment was taken one of the built-in ways, and the
-- enum value it stored *is* that way's code.
UPDATE payments p
   SET payment_method_id = pm.id
  FROM locations l, payment_methods pm
 WHERE l.id = p.location_id
   AND pm.business_id = l.business_id
   AND pm.code = p.method::text
   AND p.payment_method_id IS NULL;
