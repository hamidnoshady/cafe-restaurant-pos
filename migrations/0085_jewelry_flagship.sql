-- Phase 27 Wave 9 — jewelry flagship: gram-denominated layaway, gold buy-back,
-- the customer gold account (حساب طلایی), and custom-order tickets.
--
-- Layaway is denominated in grams so an instalment plan survives a gold-price
-- move: the per-gram price is locked at open, and the grams never change.
-- The gold account is a per-customer *gram* subledger (طلب/بدهی وزنی) — the
-- balance is a SUM of signed movements, never a stored column — and its Rial
-- value posts through the domain-event engine against a customer-gold
-- liability. Buy-back is a second role on `gold_prices` (the day's buy rate),
-- and an intake creates a scrap `items` row with weight attributes.

-- The day's buy rate (خرید طلای دست‌دوم و آبشده), a second role alongside the
-- sell-side price_per_gram. Nullable: a day with no buy rate simply refuses
-- buy-backs, it never falls back to the sell price.
ALTER TABLE gold_prices ADD COLUMN buy_price_per_gram bigint CHECK (buy_price_per_gram IS NULL OR buy_price_per_gram > 0);

-- Customer-deposit liability (2430) and gold-account liability (2450), for the
-- jewelry trade only — the two new postings this wave introduces.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '2000'
CROSS JOIN (VALUES ('2430', 'پیش‌دریافت مشتری', 'liability'), ('2450', 'حساب طلایی مشتریان', 'liability')) v(code, name, type)
WHERE b.industry = 'jewelry'
ON CONFLICT (business_id, code) DO NOTHING;

-- --------------------------------------------------------------- layaway

CREATE TABLE layaway_plan_counters (
    location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    next_number bigint NOT NULL DEFAULT 1
);

ALTER TABLE layaway_plan_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE layaway_plan_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON layaway_plan_counters FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

CREATE TABLE layaway_plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    plan_number     bigint NOT NULL,
    customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    -- Optional link to the specific piece being held; a gram plan for bulk
    -- gold has none.
    item_id         uuid REFERENCES items(id) ON DELETE SET NULL,
    -- The denomination: grams, never Rial. The price is locked below.
    grams           numeric(24, 9) NOT NULL CHECK (grams > 0),
    price_per_gram  bigint NOT NULL CHECK (price_per_gram > 0),
    total_value_rial bigint NOT NULL CHECK (total_value_rial > 0),
    paid_rial       bigint NOT NULL DEFAULT 0 CHECK (paid_rial >= 0),
    status          text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'completed', 'cancelled')),
    promised_date   date,
    completed_at    timestamptz,
    cancelled_at    timestamptz,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, plan_number)
);

CREATE INDEX idx_layaway_plans_business ON layaway_plans (business_id);
CREATE INDEX idx_layaway_plans_customer ON layaway_plans (customer_id);

ALTER TABLE layaway_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE layaway_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON layaway_plans FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- One row per instalment (including the initial deposit). Each deposit posts
-- its own journal entry keyed to its own payment row, so the unique
-- (business_id, source_type, source_id, posting_kind) posting index never
-- collides between two payments on the same plan.
CREATE TABLE layaway_payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    layaway_plan_id uuid NOT NULL REFERENCES layaway_plans(id) ON DELETE CASCADE,
    amount_rial     bigint NOT NULL CHECK (amount_rial > 0),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_layaway_payments_plan ON layaway_payments (layaway_plan_id);

ALTER TABLE layaway_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE layaway_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON layaway_payments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- --------------------------------------------------------- gold account

CREATE TABLE gold_account_movements (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    -- Signed: positive = the shop now holds this many grams for the customer
    -- (طلب به نفع مشتری), negative = withdrawn. Balance = SUM(grams).
    grams           numeric(24, 9) NOT NULL CHECK (grams <> 0),
    price_per_gram  bigint NOT NULL CHECK (price_per_gram > 0),
    -- Signed Rial value = grams × price_per_gram, the amount the posting used.
    value_rial      bigint NOT NULL CHECK (value_rial <> 0),
    reason          text,
    source_type     text NOT NULL,
    source_id       uuid,
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gold_account_movements_business ON gold_account_movements (business_id);
CREATE INDEX idx_gold_account_movements_customer ON gold_account_movements (customer_id);

ALTER TABLE gold_account_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_account_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gold_account_movements FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- --------------------------------------------------------- custom orders

CREATE TABLE custom_order_counters (
    location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    next_number bigint NOT NULL DEFAULT 1
);

ALTER TABLE custom_order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_order_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_order_counters FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

CREATE TABLE custom_order_tickets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    ticket_number    bigint NOT NULL,
    customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
    item_description text NOT NULL,
    -- The metal being ordered, in grams (requested weight).
    grams            numeric(24, 9) NOT NULL CHECK (grams > 0),
    deposit_rial     bigint NOT NULL DEFAULT 0 CHECK (deposit_rial >= 0),
    labor_charge     bigint NOT NULL DEFAULT 0 CHECK (labor_charge >= 0),
    status           text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'in_progress', 'ready', 'closed', 'cancelled')),
    promised_date    date,
    closed_at        timestamptz,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, ticket_number)
);

CREATE INDEX idx_custom_order_tickets_location ON custom_order_tickets (location_id);
CREATE INDEX idx_custom_order_tickets_customer ON custom_order_tickets (customer_id);

ALTER TABLE custom_order_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_order_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_order_tickets FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));
