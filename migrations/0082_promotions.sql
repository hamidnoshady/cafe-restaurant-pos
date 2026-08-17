-- Phase 27 Wave 6 — promotions (کمپین تخفیف) and gift cards (کارت هدیه).
--
-- `promotions` is a per-business catalogue the pure engine
-- (src/lib/promotions.ts) evaluates over a cart, called by both F&B's
-- order totals and the retail invoice path. Every field the engine needs —
-- kind, value, scope, date/day/time window, priority, stacking — is stored
-- here, so the database row is the source of truth and the engine stays a
-- pure function of a cart plus these rows.
--
-- `gift_cards` is the card's identity only. Its outstanding value is a real
-- liability (2420, «کارت هدیه») posted through the domain-event engine — the
-- same never-a-column discipline store credit (Wave 5) and consignment use.
--
-- RLS in the same migration for both new tables.

-- Gift-card liability, added to every business (any trade can sell and accept
-- gift cards).
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '2000'
CROSS JOIN (VALUES ('2420', 'کارت هدیه', 'liability')) v(code, name, type)
ON CONFLICT (business_id, code) DO NOTHING;

CREATE TABLE promotions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name         text NOT NULL,
    kind         text NOT NULL
                   CHECK (kind IN ('percent', 'amount', 'bundle_price', 'buy_x_get_y')),
    -- percent: integer percent (0-100). amount/bundle_price/buy_x_get_y: Rial.
    value        bigint NOT NULL,
    -- buy_x_get_y only: the quantity that unlocks the set price.
    min_quantity integer CHECK (min_quantity IS NULL OR min_quantity > 0),
    -- Scope: an empty array means "everything".
    item_ids     uuid[] NOT NULL DEFAULT '{}',
    brand_ids    uuid[] NOT NULL DEFAULT '{}',
    category_ids uuid[] NOT NULL DEFAULT '{}',
    active_from  date,
    active_to    date,
    -- 0-6, JS Date.getDay() convention (0 = Sunday); empty = every day.
    days_of_week smallint[] NOT NULL DEFAULT '{}',
    time_from    time,
    time_to      time,
    -- Higher applies first; ties break by id in the engine.
    priority     integer NOT NULL DEFAULT 0,
    stacking     text NOT NULL DEFAULT 'exclusive' CHECK (stacking IN ('exclusive', 'stackable')),
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_promotions_business ON promotions (business_id);

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON promotions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

CREATE TABLE gift_cards (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The code a customer enters or the cashier scans; unique per business.
    code          text NOT NULL,
    initial_value bigint NOT NULL CHECK (initial_value > 0),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, code)
);

CREATE INDEX idx_gift_cards_business ON gift_cards (business_id);

ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gift_cards FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
